import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateTestHelloIdentity } from "./hello-identity.js";
import type { NodeIdentity } from "./node-credential-auth.js";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_URL: "https://proxy.example.com",
    WMP_TERMINAL_USER_LIMIT: 8,
    WMP_TERMINAL_CLI_LIMIT: 4,
  },
}));

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const routing = vi.hoisted(() => ({
  disconnectNodeAtGeneration: vi.fn(async () => true),
  markTargetsDueAfterNodeReconnect: vi.fn(async () => 0),
}));
vi.mock("@ws-model-proxy/api/lib/pool-routing", () => routing);

vi.mock("../model-api/cache-affinity-observers.js", () => ({
  acknowledgeAffinityObservations: vi.fn(async () => undefined),
  discoverAffinityObservers: vi.fn(async () => undefined),
  observeAffinityReset: vi.fn(async () => []),
  recoverAffinityObservers: vi.fn(async () => undefined),
  registerAffinityObservers: vi.fn(async () => undefined),
  renewAffinityObservers: vi.fn(async () => undefined),
}));
vi.mock("../model-api/cache-affinity-generation.js", () => ({
  persistAffinityCounterEpoch: vi.fn(async () => undefined),
  readAffinityCounterEpoch: vi.fn(async () => null),
}));
vi.mock("../model-api/cache-affinity-residency.js", () => ({
  beginAffinityReset: vi.fn(() => () => undefined),
}));
vi.mock("../model-api/kv-eviction-feedback.js", () => ({
  resetKvEvictionForInstance: vi.fn(async () => undefined),
}));
vi.mock("./runtime-load-rollup.js", () => ({ observeRuntimeLoadRollup: vi.fn() }));
vi.mock("./node-metrics-rollup.js", () => ({ observeNodeMetricsRollup: vi.fn() }));

const { default: prisma } = await import("@ws-model-proxy/db");
const { RelaySessionManager, OPERATOR_ACCEPT_RETRIES } = await import("./session-manager.js");
const { observeRuntimeLoadRollup } = await import("./runtime-load-rollup.js");
const { observeNodeMetricsRollup } = await import("./node-metrics-rollup.js");

const db = prisma as unknown as {
  $transaction: MockInstance;
  nodeCredential: { findUnique: MockInstance; update: MockInstance; updateMany: MockInstance };
  node: { update: MockInstance; updateMany: MockInstance; findUnique: MockInstance };
  runtimeInstance: { findMany: MockInstance; findFirst: MockInstance };
  executionTarget: { findMany: MockInstance };
};

const testIdentity = generateTestHelloIdentity();
const identity: NodeIdentity = {
  credentialId: "cred-1",
  userId: "user-1",
  nodeId: "node-1",
  identityPublicKey: testIdentity.publicKey,
};
const ORIGIN = "https://proxy.example.com";
const TERMINAL_KEY = (() => {
  const bytes = Buffer.alloc(65, 9);
  bytes[0] = 0x04;
  return bytes.toString("base64url");
})();
let generation = 0;

class FakeSocket {
  readyState = 1;
  bufferedAmount = 0;
  sends: Array<string | ArrayBuffer> = [];
  closes: Array<{ code?: number; reason?: string }> = [];
  send(data: string | ArrayBuffer | Uint8Array) {
    this.sends.push(data instanceof Uint8Array ? data.slice().buffer : data);
  }
  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.closes.push({ code, reason });
  }
  json(): Array<Record<string, unknown>> {
    return this.sends
      .filter((send): send is string => typeof send === "string")
      .map((send) => JSON.parse(send) as Record<string, unknown>);
  }
  last(type: string) {
    return this.json().findLast((frame) => frame.type === type);
  }
}

function challenge(socket: FakeSocket): string {
  const frame = socket.json().find((message) => message.type === "hello.challenge");
  return String(frame?.nonce);
}

function hello(
  socket: FakeSocket,
  overrides: {
    trust?: "full" | "relay";
    signature?: string;
    operatorTerminals?: boolean;
    jobReservations?: boolean;
  } = {},
) {
  const trust = overrides.trust ?? "full";
  return JSON.stringify({
    type: "hello",
    id: "hello-1",
    protocolVersion: "3.0",
    node: {
      slug: "box",
      version: "0.4.0",
      identityPublicKey: testIdentity.publicKey,
      identitySignature: overrides.signature ?? testIdentity.sign(challenge(socket), "box", ORIGIN),
      terminalPublicKey: TERMINAL_KEY,
    },
    trust: { value: trust, frozen: trust === "relay" },
    features: {
      terminals: { supported: true, max: 4, approvalRequired: false },
      operatorTerminals: overrides.operatorTerminals ?? false,
      files: { roots: ["/home/me"], asRoot: false, source: "configured" },
      runtimeHosts: [],
      mediaExpand: false,
      liveStt: false,
      ...(overrides.jobReservations === undefined
        ? {}
        : { jobReservations: overrides.jobReservations }),
      secrets: [],
    },
    definitions: [],
    heldMetricCommandsHash: null,
    heldPortRange: null,
    heldFabricsHash: null,
  });
}

function credentialRow(overrides: Record<string, unknown> = {}) {
  return {
    revokedAt: null,
    identityPublicKey: testIdentity.publicKey,
    User: { banned: false, banExpires: null, deletionRequestedAt: null },
    Node: {
      id: "node-1",
      userId: "user-1",
      slug: "box",
      trust: "FULL",
      trustLowerRequestedAt: null,
    },
    ...overrides,
  };
}

describe("RelaySessionManager (relay 3.0)", () => {
  let manager: InstanceType<typeof RelaySessionManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new RelaySessionManager();
    db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) =>
      callback(db),
    );
    db.nodeCredential.findUnique.mockResolvedValue(credentialRow());
    db.nodeCredential.update.mockResolvedValue({});
    db.node.update.mockImplementation(async () => ({ connectionGeneration: ++generation }));
    db.node.updateMany.mockResolvedValue({ count: 1 });
    db.runtimeInstance.findMany.mockResolvedValue([]);
    db.runtimeInstance.findFirst.mockResolvedValue(null);
    db.executionTarget.findMany.mockResolvedValue([]);
  });

  afterEach(() => {
    manager.dispose();
  });

  async function connect(options: Parameters<typeof hello>[1] = {}) {
    const socket = new FakeSocket();
    expect(manager.acceptAuthenticatedSocket({ socket, identity })).toBe(true);
    await manager.handleTextFrame(socket, hello(socket, options));
    return socket;
  }

  it("registers a signed 3.0 hello and answers hello.ok with the node id", async () => {
    const socket = await connect();
    expect(socket.last("hello.ok")).toEqual({
      type: "hello.ok",
      id: "hello-1",
      protocolVersion: "3.0",
      nodeId: "node-1",
      definitionSync: "none",
    });
    expect(manager.getOnlineNodeIds()).toEqual(["node-1"]);
    expect(manager.getLiveNodeState("node-1")).toMatchObject({ trust: "full", slug: "box" });
    expect(routing.markTargetsDueAfterNodeReconnect).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: "node-1" }),
    );
  });

  it("refuses a hello whose identity proof does not verify", async () => {
    const socket = await connect({ signature: Buffer.alloc(64, 1).toString("base64url") });
    expect(socket.last("protocol.error")).toMatchObject({ code: "malformed" });
    expect(socket.closes).toHaveLength(1);
    expect(manager.getOnlineNodeIds()).toEqual([]);
    expect(db.node.update).not.toHaveBeenCalled();
  });

  it("refuses a 2.x hello with an upgrade message and remembers it", async () => {
    const socket = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket, identity });
    await manager.handleTextFrame(
      socket,
      JSON.stringify({ type: "hello", id: "h", protocolVersion: "2.9", cli: { version: "0.3.9" } }),
    );
    expect(socket.last("protocol.error")).toMatchObject({
      code: "upgrade_cli",
      supportedVersions: ["3.0"],
    });
    expect(db.node.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rejectedProtocolVersion: "2.9",
          rejectedCliVersion: "0.3.9",
        }),
      }),
    );
  });

  it("refuses a 3.0 hello from an older wsmp build with an upgrade message and remembers it", async () => {
    const socket = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket, identity });
    // Same protocol, but missing fields this server requires (e.g. features.files.source).
    await manager.handleTextFrame(
      socket,
      JSON.stringify({
        type: "hello",
        id: "h",
        protocolVersion: "3.0",
        node: { version: "0.4.0" },
      }),
    );
    expect(socket.last("protocol.error")).toMatchObject({ code: "upgrade_cli" });
    expect(socket.closes).toHaveLength(1);
    expect(manager.getOnlineNodeIds()).toEqual([]);
    expect(db.node.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rejectedProtocolVersion: "3.0",
          rejectedCliVersion: "0.4.0",
        }),
      }),
    );
  });

  it("refuses an identity key other than the enrolled one", async () => {
    db.nodeCredential.findUnique.mockResolvedValue(credentialRow({ identityPublicKey: "other" }));
    const socket = await connect();
    expect(socket.last("protocol.error")).toMatchObject({ code: "identity_mismatch" });
    expect(db.nodeCredential.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastRefusedReason: "identity_mismatch" }),
      }),
    );
    expect(manager.getOnlineNodeIds()).toEqual([]);
  });

  it("sends trust.lower when a person's lowering is still unconfirmed, and applies Relay", async () => {
    const requestedAt = new Date("2026-10-01T00:00:00.000Z");
    db.nodeCredential.findUnique.mockResolvedValue(
      credentialRow({
        Node: {
          id: "node-1",
          userId: "user-1",
          slug: "box",
          trust: "FULL",
          trustLowerRequestedAt: requestedAt,
        },
      }),
    );
    const socket = await connect();
    expect(socket.last("trust.lower")).toMatchObject({ requestedAt: requestedAt.toISOString() });
    expect(manager.getLiveNodeState("node-1")?.trust).toBe("relay");
  });

  it("declares the exact body length so the node never sends a chunked body", async () => {
    const socket = await connect();
    const body = new TextEncoder().encode('{"model":"m","messages":[]}');
    manager.sendRelayRequest({
      nodeId: "node-1",
      handle: "llama",
      requestId: "req-len",
      family: "chat.completions",
      method: "POST",
      path: "/v1/chat/completions",
      headers: { "content-type": "application/json" },
      bodyChunks: [body.subarray(0, 5), body.subarray(5)],
      timeoutMs: 60_000,
    });
    expect(socket.last("relay.request")).toMatchObject({
      expectBody: true,
      bodyBytes: body.byteLength,
    });
  });

  it("sends relay requests by handle and routes the answer only from the owning node", async () => {
    const socket = await connect();
    const onComplete = vi.fn();
    manager.registerRelayResponseHandlers({
      nodeId: "node-1",
      requestId: "req-1",
      handlers: {
        onHeaders: vi.fn(),
        onBody: vi.fn(),
        onComplete,
        onError: vi.fn(),
        onCancelled: vi.fn(),
      },
    });
    manager.sendRelayRequest({
      nodeId: "node-1",
      handle: "llama",
      requestId: "req-1",
      family: "chat.completions",
      method: "POST",
      path: "/v1/chat/completions",
      headers: { "content-type": "application/json" },
      timeoutMs: 60_000,
    });
    expect(socket.last("relay.request")).toMatchObject({ handle: "llama", expectBody: false });
    expect(socket.last("relay.request")).not.toHaveProperty("bodyBytes");
    await manager.handleTextFrame(
      socket,
      JSON.stringify({ type: "relay.complete", requestId: "req-1" }),
    );
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(() =>
      manager.sendRelayRequest({
        nodeId: "node-2",
        handle: "llama",
        requestId: "req-2",
        family: "chat.completions",
        method: "POST",
        path: "/v1/chat/completions",
        headers: {},
        timeoutMs: 60_000,
      }),
    ).toThrow("disconnected");
  });

  it("keeps a handle served when the lifecycle finds its record stale (T6, DCR-P4)", async () => {
    const socket = await connect();
    // The lifecycle reports the stopped record as about an earlier run (or from before this
    // run's launch): what the session served for that handle stays as it was.
    const stale: string[] = [];
    const handler = vi.fn(async () => ({ ok: true as const, stale: [...stale] }));
    manager.setNodeFrameHandlers({ runtimeInventory: handler });
    const record = {
      instanceId: "inst-1",
      launchVersionId: "ver-1",
      launchHash: "b".repeat(64),
      rank: 0,
      intentHash: "c".repeat(64),
      phase: "ready",
      unitName: "wsmp-i-0123456789ab-r0",
      port: 8000,
      handle: "i-0123456789ab",
      models: ["m"],
      stepId: "current-readiness",
    };
    const frame = (snapshotId: string, instances: unknown[]) =>
      JSON.stringify({
        type: "runtime.inventory",
        snapshotId,
        chunkIndex: 0,
        final: true,
        alwaysOn: [],
        instances,
      });
    await manager.handleTextFrame(socket, frame("a".repeat(32), [record]));
    expect(manager.getLiveNodeState("node-1")?.servedHandles).toContain(record.handle);
    stale.push(record.handle);
    await manager.handleTextFrame(
      socket,
      frame("d".repeat(32), [{ ...record, phase: "stopped", stepId: "old-leading-stop" }]),
    );
    expect(handler).toHaveBeenCalledTimes(2);
    expect(manager.getLiveNodeState("node-1")?.servedHandles).toContain(record.handle);
    // A stale ready record does not start serving a handle that was not served.
    stale.push("i-ffffffffffff");
    await manager.handleTextFrame(
      socket,
      frame("e".repeat(32), [
        { ...record, phase: "stopped", stepId: "old-leading-stop" },
        { ...record, handle: "i-ffffffffffff", unitName: "wsmp-i-ffffffffffff-r0" },
      ]),
    );
    expect(manager.getLiveNodeState("node-1")?.servedHandles).toContain(record.handle);
    expect(manager.getLiveNodeState("node-1")?.servedHandles).not.toContain("i-ffffffffffff");
    // Control: the same stopped record, not stale, withdraws the handle.
    stale.length = 0;
    await manager.handleTextFrame(
      socket,
      frame("f".repeat(32), [{ ...record, phase: "stopped", stepId: "current-stop" }]),
    );
    expect(manager.getLiveNodeState("node-1")?.servedHandles).not.toContain(record.handle);
  });

  it("R4-B-1: an older inventory that finishes after a newer one changes nothing served (publication order)", async () => {
    const socket = await connect();
    const aEntered = Promise.withResolvers<void>();
    const aResume = Promise.withResolvers<void>();
    manager.setNodeFrameHandlers({
      runtimeInventory: async (_ref, snapshot) => {
        if (snapshot.snapshotId === "a".repeat(32)) {
          // A's stopped record was owned/fresh when checked; B's newer run has not committed yet.
          aEntered.resolve();
          // Real handler work can still await another rank or applyAlwaysOnInventory after that check.
          await aResume.promise;
        }
        return { ok: true as const, stale: [] };
      },
    });
    const handle = "i-0123456789ab";
    const record = {
      instanceId: "inst-1",
      launchVersionId: "ver-1",
      launchHash: "b".repeat(64),
      rank: 0,
      intentHash: "c".repeat(64),
      phase: "ready",
      unitName: "wsmp-i-0123456789ab-r0",
      port: 8000,
      handle,
      models: ["m"],
      stepId: "new-readiness",
    };
    const frame = (snapshotId: string, phase: string, stepId: string) =>
      JSON.stringify({
        type: "runtime.inventory",
        snapshotId,
        chunkIndex: 0,
        final: true,
        alwaysOn: [],
        instances: [{ ...record, phase, stepId }],
      });
    const older = manager.handleTextFrame(socket, frame("a".repeat(32), "stopped", "old-stop"));
    await aEntered.promise;
    await manager.handleTextFrame(socket, frame("d".repeat(32), "ready", "new-readiness"));
    expect(manager.getLiveNodeState("node-1")?.servedHandles).toContain(handle);
    db.runtimeInstance.findFirst.mockResolvedValue({
      id: "inst-1",
      runtimeId: "rt-1",
      versionId: "ver-1",
    });
    await manager.handleTextFrame(
      socket,
      JSON.stringify({
        type: "runtime.load",
        handle,
        running: 2,
        waiting: 0,
        counterEpoch: 0,
        source: "builtin",
        ts: new Date().toISOString(),
      }),
    );
    expect(manager.getLiveNodeTelemetry(["node-1"]).get("node-1")?.runtimeLoad).toHaveLength(1);
    const consumer = { onEvent: vi.fn(), onDrain: vi.fn(), onEnd: vi.fn() };
    const created = manager.createSttSession({ consumer });
    if (!created.ok) throw new Error(created.reason);
    const target = {
      nodeId: "node-1",
      handle,
      upstreamModel: "whisper",
      capabilities: {
        version: 2 as const,
        protocol: "openai-compatible" as const,
        audio: {
          transcriptions: {
            supported: true as const,
            realtime: {
              supported: true as const,
              adapter: "segmented" as const,
              maxItemSeconds: 10,
            },
          },
        },
      },
    };
    const opening = created.session.attach(target);
    const sessionId = created.session.relaySessionId;
    expect(sessionId).toBeTruthy();
    await manager.handleTextFrame(socket, JSON.stringify({ type: "stt.opened", sessionId }));
    await expect(opening).resolves.toMatchObject({ status: "opened" });
    expect(consumer.onEnd).not.toHaveBeenCalled();
    aResume.resolve();
    await older;
    // Finishing the older snapshot A does not roll the newer B back: the handle stays served,
    // its load reading and its STT session stay, and affinity keeps the handle.
    expect(manager.getLiveNodeState("node-1")?.servedHandles).toContain(handle);
    expect(manager.getLiveNodeTelemetry(["node-1"]).get("node-1")?.runtimeLoad).toHaveLength(1);
    expect(consumer.onEnd).not.toHaveBeenCalled();
    const { registerAffinityObservers } = await import("../model-api/cache-affinity-observers.js");
    expect(registerAffinityObservers).toHaveBeenLastCalledWith(
      expect.objectContaining({ handles: [handle] }),
    );
  });

  it("R4-B-1: a refused newer inventory keeps what was served, and an older one finishing later cannot replace it", async () => {
    const socket = await connect();
    const aEntered = Promise.withResolvers<void>();
    const aResume = Promise.withResolvers<void>();
    manager.setNodeFrameHandlers({
      runtimeInventory: async (_ref, snapshot) => {
        if (snapshot.snapshotId === "a".repeat(32)) {
          aEntered.resolve();
          await aResume.promise;
          return { ok: true as const, stale: [] };
        }
        if (snapshot.snapshotId === "d".repeat(32))
          return { ok: false as const, message: "could not classify" };
        return { ok: true as const, stale: [] };
      },
    });
    const handle = "i-0123456789ab";
    const record = {
      instanceId: "inst-1",
      launchVersionId: "ver-1",
      launchHash: "b".repeat(64),
      rank: 0,
      intentHash: "c".repeat(64),
      phase: "ready",
      unitName: "wsmp-i-0123456789ab-r0",
      port: 8000,
      handle,
      models: ["m"],
      stepId: "readiness",
    };
    const frame = (snapshotId: string, phase: string) =>
      JSON.stringify({
        type: "runtime.inventory",
        snapshotId,
        chunkIndex: 0,
        final: true,
        alwaysOn: [],
        instances: [{ ...record, phase }],
      });
    await manager.handleTextFrame(socket, frame("e".repeat(32), "ready"));
    expect(manager.getLiveNodeState("node-1")?.servedHandles).toContain(handle);
    const older = manager.handleTextFrame(socket, frame("a".repeat(32), "stopped"));
    await aEntered.promise;
    await manager.handleTextFrame(socket, frame("d".repeat(32), "stopped"));
    expect(manager.getLiveNodeState("node-1")?.servedHandles).toContain(handle);
    aResume.resolve();
    await older;
    expect(manager.getLiveNodeState("node-1")?.servedHandles).toContain(handle);
  });

  it("assembles chunked inventory, hands it to its handler and acknowledges it", async () => {
    const socket = await connect();
    const runtimeInventory = vi.fn(async () => ({ ok: true as const }));
    manager.setNodeFrameHandlers({ runtimeInventory });
    const snapshotId = "a".repeat(32);
    const chunk = (chunkIndex: number, final: boolean) =>
      JSON.stringify({
        type: "runtime.inventory",
        snapshotId,
        chunkIndex,
        final,
        alwaysOn: [],
        instances:
          chunkIndex === 0
            ? []
            : [
                {
                  instanceId: "inst-1",
                  launchVersionId: "ver-1",
                  launchHash: "b".repeat(64),
                  rank: 0,
                  intentHash: "c".repeat(64),
                  phase: "ready",
                  unitName: "wsmp-i-0123456789ab-r0",
                  port: 8000,
                  handle: "i-0123456789ab",
                  models: ["m"],
                },
              ],
      });
    await manager.handleTextFrame(socket, chunk(0, false));
    expect(socket.last("runtime.inventory.ok")).toBeUndefined();
    await manager.handleTextFrame(socket, chunk(1, true));
    expect(runtimeInventory).toHaveBeenCalledTimes(1);
    expect(socket.last("runtime.inventory.ok")).toEqual({
      type: "runtime.inventory.ok",
      snapshotId,
    });
    expect(manager.getLiveNodeState("node-1")?.servedHandles).toEqual(["i-0123456789ab"]);

    await manager.handleTextFrame(socket, chunk(1, true));
    expect(socket.last("runtime.inventory.error")).toMatchObject({ snapshotId });
  });

  it("routes lane frames to their handler and sends lane frames to the live node", async () => {
    const socket = await connect();
    const secretResult = vi.fn();
    manager.setNodeFrameHandlers({ "secret.result": secretResult });
    await manager.handleTextFrame(
      socket,
      JSON.stringify({ type: "secret.result", id: "s1", name: "WSMP_SECRET_X", status: "deleted" }),
    );
    expect(secretResult).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: "node-1", userId: "user-1" }),
      expect.objectContaining({ id: "s1" }),
    );
    expect(manager.sendToNode("node-1", { type: "runtime.detect", id: "d1" })).toBe(true);
    expect(socket.last("runtime.detect")).toEqual({ type: "runtime.detect", id: "d1" });
    expect(manager.sendToNode("node-2", { type: "runtime.detect", id: "d1" })).toBe(false);
  });

  it("pins lane sends to the live session and its Full control", async () => {
    await connect();
    const session = manager.nodeSession("node-1");
    expect(session).toEqual({
      userId: "user-1",
      connectionGeneration: generation,
      trust: "full",
      operatorTerminals: false,
      // A hello without the flag (a CLI from before it): job reservations are not sent.
      jobReservations: false,
    });
    const frame = { type: "runtime.detect" as const, id: "d2" };
    expect(manager.sendToNode("node-1", frame, { connectionGeneration: generation + 1 })).toBe(
      false,
    );
    expect(
      manager.sendToNode("node-1", frame, {
        connectionGeneration: generation,
        requireFullTrust: true,
      }),
    ).toBe(true);
    manager.requestTrustLower("node-1", new Date());
    expect(manager.sendToNode("node-1", frame, { requireFullTrust: true })).toBe(false);
    expect(manager.nodeSession("node-1")?.trust).toBe("relay");
  });

  it("says when the node's CLI reads job reservations", async () => {
    await connect({ jobReservations: true });
    expect(manager.nodeSession("node-1")?.jobReservations).toBe(true);
  });

  it("never delivers a stop, status or health job of a run older than a start it sent", async () => {
    const socket = await connect();
    const job = (
      phase: "start" | "stop" | "status" | "health" | "readiness",
      generation: number,
    ) => ({
      type: "runtime.job" as const,
      stepId: `step-${phase}-${generation}`,
      instanceId: "inst-1",
      runtimeId: "rt-1",
      launchVersionId: "v-1",
      launchHash: "b".repeat(64),
      generation,
      rank: 0,
      nnodes: 1,
      phase,
      handle: "i-abcdefabcdef",
      unitName: "wsmp-i-abcdefabcdef-r0",
      placeholders: { port: 30_000 },
      timeoutMs: 60_000,
      ownerEpoch: "e1:1",
      intentHash: "a".repeat(64),
    });
    // Run 1 starts; its health and stop go out while it is the latest started run.
    expect(manager.sendToNode("node-1", job("start", 1))).toBe(true);
    expect(manager.sendToNode("node-1", job("health", 1))).toBe(true);
    // Run 2's leading stop (same run number) and start go out.
    expect(manager.sendToNode("node-1", job("stop", 2))).toBe(true);
    expect(manager.sendToNode("node-1", job("start", 2))).toBe(true);
    const sent = socket.json().filter((frame) => frame.type === "runtime.job").length;
    // A stop, status probe or health probe of run 1 claimed before run 2 began is not sent now.
    for (const phase of ["stop", "status", "health"] as const)
      expect(manager.sendToNode("node-1", job(phase, 1))).toBe(false);
    expect(socket.json().filter((frame) => frame.type === "runtime.job")).toHaveLength(sent);
    // Run 2's own jobs, and another rank's or instance's, still go.
    expect(manager.sendToNode("node-1", job("stop", 2))).toBe(true);
    expect(
      manager.sendToNode("node-1", {
        ...job("stop", 1),
        rank: 1,
        unitName: "wsmp-i-abcdefabcdef-r1",
        nnodes: 2,
        fabricId: "fab_1",
        placeholders: { port: 30_000, head_addr: "10.0.0.1" },
      }),
    ).toBe(true);
    expect(manager.sendToNode("node-1", { ...job("stop", 1), instanceId: "inst-2" })).toBe(true);
    // A new session (reconnect) starts fresh: the lifecycle's run gate covers it.
    await connect();
    expect(manager.sendToNode("node-1", job("stop", 1))).toBe(true);
  });

  it("sends nothing pinned to another owner, and logs the class only", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const socket = await connect();
      const frame = { type: "runtime.detect" as const, id: "d3" };
      expect(manager.sendToNode("node-1", frame, { userId: "user-2" })).toBe(false);
      expect(
        manager.sendToNode("node-1", frame, { userId: "user-2", ownerCheck: "runtime_step" }),
      ).toBe(false);
      expect(socket.last("runtime.detect")).toBeUndefined();
      expect(warn.mock.calls).toEqual([
        ["[relay] refused a send to a node of another owner", "frame"],
        ["[relay] refused a send to a node of another owner", "runtime_step"],
      ]);
      // A guard naming no owner (a slip upstream) is refused too, not skipped.
      expect(manager.sendToNode("node-1", frame, { userId: undefined })).toBe(false);
      expect(socket.last("runtime.detect")).toBeUndefined();
      // The owner's own frame goes out.
      expect(manager.sendToNode("node-1", frame, { userId: "user-1" })).toBe(true);
      expect(socket.last("runtime.detect")).toEqual(frame);
    } finally {
      warn.mockRestore();
    }
  });

  it("sends a file op only to the owner's live Full session and routes its answer back", async () => {
    const socket = await connect();
    const opId = Buffer.alloc(16, 7).toString("base64url");
    const tracked = (userId: string) => ({
      opId,
      nodeId: "node-1",
      userId,
      op: "read" as const,
      markResult: vi.fn(),
      markData: vi.fn(),
      markRejected: vi.fn(),
      markMalformed: vi.fn(),
      markLost: vi.fn(),
    });
    const frame = {
      type: "file.op" as const,
      opId,
      op: "read" as const,
      args: { path: "/home/me/a.txt" },
    };
    // Another owner's op never reaches this node's session.
    const foreign = tracked("user-2");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(manager.dispatchFileOp(foreign, frame)).toBe(false);
    warn.mockRestore();
    expect(socket.last("file.op")).toBeUndefined();

    const own = tracked("user-1");
    expect(manager.dispatchFileOp(own, frame)).toBe(true);
    expect(socket.last("file.op")).toEqual(frame);
    await manager.handleTextFrame(
      socket,
      JSON.stringify({ type: "file.rejected", opId, reason: "path_denied" }),
    );
    expect(own.markRejected).toHaveBeenCalledWith("path_denied", undefined);
    expect(foreign.markRejected).not.toHaveBeenCalled();

    // At Relay only nothing is sent.
    manager.forgetFileOp("node-1", opId);
    manager.requestTrustLower("node-1", new Date());
    expect(manager.dispatchFileOp(tracked("user-1"), frame)).toBe(false);
  });

  it("sends no lane frame before hello.ok", async () => {
    let during: { session: unknown; sent: boolean } | null = null;
    manager.setNodeFrameHandlers({
      definitionSync: async () => {
        during = {
          session: manager.nodeSession("node-1"),
          sent: manager.sendToNode("node-1", { type: "runtime.detect", id: "early" }),
        };
        return "none";
      },
    });
    const socket = await connect();
    expect(during).toEqual({ session: null, sent: false });
    expect(socket.last("hello.ok")).toBeDefined();
    expect(manager.nodeSession("node-1")).not.toBeNull();
  });

  it("tells the handlers when the node raises itself back to Full control", async () => {
    const socket = await connect({ trust: "relay" });
    const trustRaised = vi.fn();
    manager.setNodeFrameHandlers({ trustRaised });
    db.node.findUnique.mockResolvedValue({
      trust: "RELAY",
      trustLowerRequestedAt: null,
      connectionGeneration: generation,
    });
    const features = {
      terminals: { supported: true, max: 4, approvalRequired: false },
      operatorTerminals: false,
      files: { roots: ["/home/me"], asRoot: false, source: "configured" },
      runtimeHosts: [],
      mediaExpand: false,
      liveStt: false,
      secrets: [],
    };
    await manager.handleTextFrame(
      socket,
      JSON.stringify({ type: "node.state", trust: { value: "full", frozen: false }, features }),
    );
    expect(trustRaised).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "node-1" }));
    // A pending person's lowering keeps the node Relay: no raise.
    trustRaised.mockClear();
    await manager.handleTextFrame(
      socket,
      JSON.stringify({ type: "node.state", trust: { value: "relay", frozen: true }, features }),
    );
    db.node.findUnique.mockResolvedValue({
      trust: "RELAY",
      trustLowerRequestedAt: new Date(),
      connectionGeneration: generation,
    });
    await manager.handleTextFrame(
      socket,
      JSON.stringify({ type: "node.state", trust: { value: "full", frozen: false }, features }),
    );
    expect(trustRaised).not.toHaveBeenCalled();
  });

  it("drops runtime.load for a handle that names no instance on the node", async () => {
    const socket = await connect();
    const load = JSON.stringify({
      type: "runtime.load",
      handle: "llama",
      running: 1,
      waiting: 0,
      counterEpoch: 0,
      source: "builtin",
      ts: new Date().toISOString(),
    });
    await manager.handleTextFrame(socket, load);
    expect(observeRuntimeLoadRollup).not.toHaveBeenCalled();
    db.runtimeInstance.findFirst.mockResolvedValue({
      id: "inst-2",
      runtimeId: "rt-1",
      versionId: "v-1",
    });
    // The miss is cached briefly; a fresh manager reads again.
    manager.dispose();
    manager = new RelaySessionManager();
    const second = await connect();
    await manager.handleTextFrame(second, load);
    expect(observeRuntimeLoadRollup).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: "inst-2", nodeId: "node-1", running: 1, full: false }),
    );
    expect(manager.getLiveNodeTelemetry(["node-1"]).get("node-1")?.runtimeLoad).toEqual([
      expect.objectContaining({ endpointSlug: "llama", instanceId: "inst-2" }),
    ]);
  });

  it("answers an instance's live load from its readings, and nothing for unknown or stale ones", async () => {
    db.runtimeInstance.findFirst.mockResolvedValue({
      id: "inst-5",
      runtimeId: "rt-1",
      versionId: "v-1",
      engineSlots: null,
      loadSignals: [],
      Version: { engine: "VLLM", kvFullThreshold: null },
    });
    const socket = await connect();
    await manager.handleTextFrame(
      socket,
      JSON.stringify({
        type: "runtime.load",
        handle: "vllm",
        running: 3,
        waiting: 2,
        kvUsage: 0.5,
        counterEpoch: 0,
        source: "builtin",
        ts: new Date().toISOString(),
      }),
    );
    const live = manager.getInstanceLiveLoad(["inst-5", "inst-other"]);
    expect([...live.keys()]).toEqual(["inst-5"]);
    expect(live.get("inst-5")).toMatchObject({ running: 3, waiting: 2, kvUsage: 0.5 });
    // Past the staleness window the reading no longer counts.
    expect(manager.getInstanceLiveLoad(["inst-5"], Date.now() + 60_000).size).toBe(0);
  });

  it("marks a runtime.load sample FULL for the history as the live verdict judges its engine", async () => {
    db.runtimeInstance.findFirst.mockResolvedValue({
      id: "inst-3",
      runtimeId: "rt-1",
      versionId: "v-1",
      engineSlots: null,
      loadSignals: [],
      Version: { engine: "VLLM", kvFullThreshold: null },
    });
    const socket = await connect();
    await manager.handleTextFrame(
      socket,
      JSON.stringify({
        type: "runtime.load",
        handle: "vllm",
        running: 4,
        waiting: 0,
        kvUsage: 0.97,
        counterEpoch: 0,
        source: "builtin",
        ts: new Date().toISOString(),
      }),
    );
    expect(observeRuntimeLoadRollup).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: "inst-3", full: true }),
    );
    // llama.cpp: KV is not its signal; busy slots are.
    db.runtimeInstance.findFirst.mockResolvedValue({
      id: "inst-4",
      runtimeId: "rt-2",
      versionId: "v-2",
      engineSlots: 4,
      loadSignals: [],
      Version: { engine: "LLAMA_CPP", kvFullThreshold: null },
    });
    const frame = (handle: string, slotsBusy: number) =>
      JSON.stringify({
        type: "runtime.load",
        handle,
        running: 4,
        waiting: 0,
        kvUsage: 0.99,
        slotsBusy,
        counterEpoch: 0,
        source: "builtin",
        ts: new Date().toISOString(),
      });
    await manager.handleTextFrame(socket, frame("llama-a", 2));
    expect(observeRuntimeLoadRollup).toHaveBeenLastCalledWith(
      expect.objectContaining({ instanceId: "inst-4", full: false }),
    );
    await manager.handleTextFrame(socket, frame("llama-b", 4));
    expect(observeRuntimeLoadRollup).toHaveBeenLastCalledWith(
      expect.objectContaining({ instanceId: "inst-4", full: true }),
    );
  });

  it("rolls up free VRAM and the node metric command values of node.metrics", async () => {
    const socket = await connect();
    await manager.handleTextFrame(
      socket,
      JSON.stringify({
        type: "node.metrics",
        ts: new Date().toISOString(),
        gpus: [
          { index: 0, vramUsedMiB: 1_000, vramTotalMiB: 24_000 },
          { index: 1, vramUsedMiB: 4_000, vramTotalMiB: 24_000 },
          { index: 2, vramUsedMiB: null, vramTotalMiB: 24_000 },
        ],
        custom: [
          { name: "gpu_power", labels: { gpu: "0" }, value: 210, ts: new Date().toISOString() },
        ],
      }),
    );
    expect(observeNodeMetricsRollup).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "node-1",
        acceleratorFreeMiB: 43_000,
        custom: [expect.objectContaining({ name: "gpu_power", value: 210 })],
      }),
    );
  });

  it("persists the disconnect fenced by the session's generation", async () => {
    const socket = await connect();
    await manager.removeSession(socket as never);
    expect(manager.getOnlineNodeIds()).toEqual([]);
    expect(routing.disconnectNodeAtGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "node-1",
        generation,
        failureClass: "WEBSOCKET_DISCONNECTED",
      }),
    );
  });

  it("closes sessions of a revoked credential", async () => {
    const socket = await connect();
    await manager.closeSessionsForRevokedCredentials({ ids: ["cred-1"] });
    expect(socket.closes).toEqual([{ code: 1008, reason: "access_denied" }]);
    expect(manager.getOnlineNodeIds()).toEqual([]);
  });

  it("never opens a browser shell for a user on another owner's node", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const socket = await connect();
      expect(
        manager.startTerminal({
          terminalId: Buffer.alloc(16, 1).toString("base64url"),
          userId: "user-2",
          nodeId: "node-1",
          cols: 80,
          rows: 24,
          browserPublicKey: TERMINAL_KEY,
          browserNonce: Buffer.alloc(16, 2).toString("base64url"),
          connId: "conn-1",
        }),
      ).toBe(false);
      expect(socket.last("term.open")).toBeUndefined();
      expect(warn.mock.calls).toEqual([
        ["[relay] refused a send to a node of another owner", "terminal_open"],
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("never sends a file op of another owner's to the node", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const socket = await connect();
      const opId = "aI2y1_whRmuQtdr_JElukw";
      const tracked = (userId: string) => ({
        opId,
        nodeId: "node-1",
        userId,
        op: "read" as const,
        markResult: vi.fn(),
        markData: vi.fn(),
        markRejected: vi.fn(),
        markMalformed: vi.fn(),
        markLost: vi.fn(),
      });
      const frame = {
        type: "file.op" as const,
        opId,
        op: "read" as const,
        args: { path: "/home/me/a.txt", maxLines: 20 },
      };
      expect(manager.dispatchFileOp(tracked("user-2"), frame)).toBe(false);
      expect(socket.last("file.op")).toBeUndefined();
      expect(warn.mock.calls).toEqual([
        ["[relay] refused a send to a node of another owner", "file_op"],
      ]);
      expect(manager.dispatchFileOp(tracked("user-1"), frame)).toBe(true);
      expect(socket.last("file.op")).toMatchObject({ opId });
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses browser shells on a node at Relay only", async () => {
    await connect({ trust: "relay" });
    expect(
      manager.startTerminal({
        terminalId: Buffer.alloc(16, 1).toString("base64url"),
        userId: "user-1",
        nodeId: "node-1",
        cols: 80,
        rows: 24,
        browserPublicKey: TERMINAL_KEY,
        browserNonce: Buffer.alloc(16, 2).toString("base64url"),
        connId: "conn-1",
      }),
    ).toBe(false);
  });

  describe("operator terminals (interactive steps)", () => {
    const terminalId = Buffer.alloc(16, 5).toString("base64url");
    const step = {
      stepId: "step-1",
      instanceId: "inst-1",
      rank: 0,
      intentHash: "a".repeat(64),
      ownerEpoch: "e1:1",
    };
    const job = (id = terminalId) => ({
      type: "runtime.job" as const,
      ...step,
      runtimeId: "rt-1",
      launchVersionId: "v-1",
      launchHash: "b".repeat(64),
      generation: 1,
      nnodes: 1,
      phase: "start" as const,
      handle: "i-abcdefabcdef",
      unitName: "wsmp-i-abcdefabcdef-r0",
      placeholders: { port: 30_000 },
      timeoutMs: 60_000,
      operator: { terminalId: id, commandAuthor: "user" as const },
    });
    const result = (
      status: "awaiting_operator" | "operator_running" | "operator_closed" | "succeeded",
      extra: Record<string, unknown> = {},
    ) =>
      JSON.stringify({
        type: "runtime.job.result",
        ...step,
        status,
        stopped: false,
        terminalId,
        ...extra,
      });
    const attach = {
      terminalId,
      stepId: "step-1",
      userId: "user-1",
      connId: "conn-1",
      browserPublicKey: TERMINAL_KEY,
      browserNonce: Buffer.alloc(16, 2).toString("base64url"),
    };

    it("never sends an interactive job to a node without operator terminals", async () => {
      await connect();
      expect(manager.nodeSession("node-1")?.operatorTerminals).toBe(false);
      expect(manager.sendToNode("node-1", job())).toBe(false);
    });

    it("tracks the step's terminal and attaches people by step, also at Relay only", async () => {
      const socket = await connect({ trust: "relay", operatorTerminals: true });
      const handler = vi.fn();
      manager.setNodeFrameHandlers({ "runtime.job.result": handler });
      expect(manager.nodeSession("node-1")?.operatorTerminals).toBe(true);
      expect(manager.sendToNode("node-1", job())).toBe(true);
      expect(socket.last("runtime.job")).toMatchObject({ operator: { terminalId } });
      // Not attachable before the node shows its screen.
      expect(manager.operatorStepTerminal("step-1", "user-1")).toBeNull();
      expect(manager.attachOperatorTerminal(attach)).toEqual({ ok: false, error: "not_found" });

      await manager.handleTextFrame(socket, result("awaiting_operator"));
      expect(handler).toHaveBeenCalledTimes(1);
      expect(manager.operatorStepTerminal("step-1", "user-1")).toEqual({
        nodeId: "node-1",
        terminalId,
        state: "awaiting",
      });
      expect(manager.operatorStepTerminal("step-1", "user-2")).toBeNull();
      // Never a browser shell: not listed, not counted, not attachable without its step.
      expect(manager.listTerminalsForUser("user-1")).toEqual([]);
      expect(manager.terminalCounts("user-1", "node-1")).toEqual({ user: 0, node: 0 });
      expect(
        manager.attachTerminal({
          terminalId,
          userId: "user-1",
          connId: "conn-1",
          browserPublicKey: TERMINAL_KEY,
          browserNonce: attach.browserNonce,
        }),
      ).toEqual({ ok: false, error: "not_found" });
      expect(manager.closeTerminalFromBrowser(terminalId, "user-1")).toBe(false);
      expect(manager.attachOperatorTerminal({ ...attach, stepId: "step-2" })).toEqual({
        ok: false,
        error: "not_found",
      });
      const attached = manager.attachOperatorTerminal(attach);
      expect(attached.ok).toBe(true);
      expect(socket.last("term.attach")).toMatchObject({ terminalId });

      // A person pressed Enter: the run is never cut off.
      await manager.handleTextFrame(socket, result("operator_running"));
      expect(manager.closeOperatorStep("step-1", { keepRunning: true })).toBe("running");
      await manager.handleTextFrame(socket, result("operator_closed", { exitCode: 1 }));
      expect(handler).toHaveBeenCalledTimes(3);
      expect(manager.operatorStepTerminal("step-1", "user-1")).toBeNull();
      expect(manager.hasTerminal(terminalId)).toBe(false);
    });

    it("R5-B-1: delivers a failed operator_running again until the engine records it", async () => {
      const socket = await connect({ operatorTerminals: true });
      let failures = 2;
      const handler = vi.fn(async (_ref: unknown, frame: { status: string }) => {
        if (frame.status === "operator_running" && failures-- > 0)
          throw new Error("one failed persistence write");
      });
      manager.setNodeFrameHandlers({ "runtime.job.result": handler });
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.useFakeTimers();
      try {
        expect(manager.sendToNode("node-1", job())).toBe(true);
        await manager.handleTextFrame(socket, result("awaiting_operator"));
        await manager.handleTextFrame(socket, result("operator_running"));
        expect(error).toHaveBeenCalledWith(
          "[relay] node frame handler failed",
          "runtime.job.result",
          "Error",
        );
        // The node's run goes on: never cut off, still attachable.
        expect(manager.closeOperatorStep("step-1", { keepRunning: true })).toBe("running");
        expect(manager.hasTerminal(terminalId)).toBe(true);
        expect(handler).toHaveBeenCalledTimes(2);
        // Delivered again after 1 s (fails), then after 2 s (recorded): no further retry.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(handler).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(handler).toHaveBeenCalledTimes(4);
        expect(handler.mock.calls.at(-1)?.[1]).toMatchObject({
          status: "operator_running",
          stepId: "step-1",
          terminalId,
        });
        await vi.advanceTimersByTimeAsync(120_000);
        expect(handler).toHaveBeenCalledTimes(4);
      } finally {
        vi.useRealTimers();
        error.mockRestore();
      }
    });

    it("R5-B-1: stops delivering an acceptance once its run is no longer tracked, and after the retries", async () => {
      const socket = await connect({ operatorTerminals: true });
      const handler = vi.fn(async (_ref: unknown, frame: { status: string }) => {
        if (frame.status === "operator_running") throw new Error("database down");
      });
      manager.setNodeFrameHandlers({ "runtime.job.result": handler });
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.useFakeTimers();
      try {
        expect(manager.sendToNode("node-1", job())).toBe(true);
        await manager.handleTextFrame(socket, result("awaiting_operator"));
        await manager.handleTextFrame(socket, result("operator_running"));
        // Every retry fails: six more deliveries (1 + 2 + ... + 32 s), then a class-only log.
        await vi.advanceTimersByTimeAsync(63_000);
        expect(handler).toHaveBeenCalledTimes(2 + OPERATOR_ACCEPT_RETRIES);
        expect(error).toHaveBeenCalledWith(
          "[relay] operator acceptance not recorded after retries",
        );
        await vi.advanceTimersByTimeAsync(600_000);
        expect(handler).toHaveBeenCalledTimes(2 + OPERATOR_ACCEPT_RETRIES);

        // A run that ended (operator_closed) before its retry is not delivered again.
        handler.mockClear();
        expect(manager.sendToNode("node-1", job())).toBe(true);
        await manager.handleTextFrame(socket, result("awaiting_operator"));
        await manager.handleTextFrame(socket, result("operator_running"));
        await manager.handleTextFrame(socket, result("operator_closed", { exitCode: 0 }));
        const calls = handler.mock.calls.length;
        await vi.advanceTimersByTimeAsync(63_000);
        expect(handler).toHaveBeenCalledTimes(calls);
      } finally {
        vi.useRealTimers();
        error.mockRestore();
      }
    });

    it("R6-C-1: repeated failed acceptances share one retry chain, cancelled on session close", async () => {
      const socket = await connect({ operatorTerminals: true });
      const handler = vi.fn(async (_ref: unknown, frame: { status: string }) => {
        if (frame.status === "operator_running") throw new Error("database down");
      });
      manager.setNodeFrameHandlers({ "runtime.job.result": handler });
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.useFakeTimers();
      try {
        expect(manager.sendToNode("node-1", job())).toBe(true);
        await manager.handleTextFrame(socket, result("awaiting_operator"));
        const base = vi.getTimerCount();
        for (let i = 0; i < 128; i++)
          await manager.handleTextFrame(socket, result("operator_running"));
        // 128 failed duplicates: one pending retry timer, not 128.
        expect(vi.getTimerCount() - base).toBe(1);
        expect(handler).toHaveBeenCalledTimes(129);
        await manager.removeSession(socket);
        // The session's retry timer is gone with it; nothing is delivered later.
        expect(vi.getTimerCount()).toBeLessThanOrEqual(base);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(handler).toHaveBeenCalledTimes(129);
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
        error.mockRestore();
      }
    });

    it("R6-C-1: a genuine failure still retries once per step and reconciles; duplicates join it", async () => {
      const socket = await connect({ operatorTerminals: true });
      let failures = 3;
      const handler = vi.fn(async (_ref: unknown, frame: { status: string }) => {
        if (frame.status === "operator_running" && failures-- > 0)
          throw new Error("one failed persistence write");
      });
      manager.setNodeFrameHandlers({ "runtime.job.result": handler });
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.useFakeTimers();
      try {
        expect(manager.sendToNode("node-1", job())).toBe(true);
        await manager.handleTextFrame(socket, result("awaiting_operator"));
        await manager.handleTextFrame(socket, result("operator_running"));
        await manager.handleTextFrame(socket, result("operator_running"));
        // Two failed deliveries, one chain: its first retry (after 1 s) fails, the next
        // (after 2 s) is recorded, and nothing follows.
        expect(handler).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(handler).toHaveBeenCalledTimes(4);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(handler).toHaveBeenCalledTimes(5);
        expect(handler.mock.calls.at(-1)?.[1]).toMatchObject({
          status: "operator_running",
          terminalId,
        });
        await vi.advanceTimersByTimeAsync(120_000);
        expect(handler).toHaveBeenCalledTimes(5);

        // A repeat the engine records ends a pending chain at once.
        handler.mockClear();
        failures = 1;
        expect(manager.sendToNode("node-1", job())).toBe(true);
        await manager.handleTextFrame(socket, result("operator_running"));
        await manager.handleTextFrame(socket, result("operator_running"));
        expect(handler).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(handler).toHaveBeenCalledTimes(2);
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
        error.mockRestore();
      }
    });

    it("R6-C-1: dispose cancels pending acceptance retries", async () => {
      const socket = await connect({ operatorTerminals: true });
      const handler = vi.fn(async (_ref: unknown, frame: { status: string }) => {
        if (frame.status === "operator_running") throw new Error("database down");
      });
      manager.setNodeFrameHandlers({ "runtime.job.result": handler });
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.useFakeTimers();
      try {
        expect(manager.sendToNode("node-1", job())).toBe(true);
        await manager.handleTextFrame(socket, result("awaiting_operator"));
        await manager.handleTextFrame(socket, result("operator_running"));
        const calls = handler.mock.calls.length;
        manager.dispose();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(handler).toHaveBeenCalledTimes(calls);
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
        error.mockRestore();
      }
    });

    /** The session's acceptance retry chains and step trackers (white-box resource counts). */
    const retryState = (socket: FakeSocket) => {
      const sessions = Reflect.get(manager, "sessionsBySocket") as Map<
        FakeSocket,
        { acceptanceRetries: Map<string, unknown>; operatorSteps: Map<string, unknown> }
      >;
      const state = sessions.get(socket);
      if (state === undefined) throw new Error("no session for this socket");
      return state;
    };

    /**
     * Counts acceptance retry timers armed from now on (by their caller), so the audit flush and
     * the fake clock's own timers cannot blur the count.
     */
    const countRetrySchedules = () => {
      const armTimer = globalThis.setTimeout;
      let armed = 0;
      const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
        ...args: Parameters<typeof setTimeout>
      ) => {
        if (new Error().stack?.includes("scheduleOperatorAcceptance")) armed++;
        return armTimer(...args);
      }) as typeof setTimeout);
      return { count: () => armed, restore: () => spy.mockRestore() };
    };

    /**
     * The acceptance retry timers armed from now on (attributed by their caller), each live
     * until it fires or is cleared. Other module timers (the audit flush) are not counted.
     */
    const trackAcceptanceTimers = () => {
      const armTimer = globalThis.setTimeout;
      const disarmTimer = globalThis.clearTimeout;
      const live = new Set<unknown>();
      let armed = 0;
      const arm = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
        ...args: Parameters<typeof setTimeout>
      ) => {
        if (!new Error().stack?.includes("scheduleOperatorAcceptance")) return armTimer(...args);
        armed++;
        const [callback, delay, ...rest] = args;
        const handle = armTimer(
          (...callbackArgs: unknown[]) => {
            live.delete(handle);
            (callback as (...callbackArgs: unknown[]) => void)(...callbackArgs);
          },
          delay,
          ...rest,
        );
        live.add(handle);
        return handle;
      }) as typeof setTimeout);
      const disarm = vi.spyOn(globalThis, "clearTimeout").mockImplementation(((
        handle?: Parameters<typeof clearTimeout>[0],
      ) => {
        live.delete(handle);
        disarmTimer(handle);
      }) as typeof clearTimeout);
      return {
        armed: () => armed,
        live: () => live.size,
        restore: () => {
          arm.mockRestore();
          disarm.mockRestore();
        },
      };
    };

    /** A real child process whose stdout read stays pending until `release`. */
    const pendingRead = async () => {
      const { spawn } = await import("node:child_process");
      const { once } = await import("node:events");
      const child = spawn("/bin/cat", [], { stdio: ["pipe", "pipe", "pipe"] });
      const exited = once(child, "exit");
      await once(child, "spawn");
      const read = once(child.stdout, "data");
      return {
        read,
        pending: () => child.exitCode === null,
        release: async () => {
          child.stdin.end("release\n");
          await read;
        },
        stop: async () => {
          child.stdin.end();
          if (child.exitCode === null) child.kill();
          await exited;
        },
      };
    };

    it.each([
      "operator_closed",
      "succeeded",
      "failed",
      "replace",
      "closeStep",
      "closeTerminal",
      "cancelUser",
    ] as const)(
      "R6-C-1: ending the run (%s) releases its acceptance retry at once",
      async (exit) => {
        const socket = await connect({ operatorTerminals: true });
        const handler = vi.fn(async (_ref: unknown, frame: { status: string }) => {
          if (frame.status === "operator_running") throw new Error("database down");
        });
        manager.setNodeFrameHandlers({ "runtime.job.result": handler });
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        vi.useFakeTimers();
        try {
          expect(manager.sendToNode("node-1", job())).toBe(true);
          await manager.handleTextFrame(socket, result("awaiting_operator"));
          const base = vi.getTimerCount();
          await manager.handleTextFrame(socket, result("operator_running"));
          const state = retryState(socket);
          expect(state.acceptanceRetries.size).toBe(1);
          expect(vi.getTimerCount() - base).toBe(1);
          if (exit === "replace")
            expect(
              manager.sendToNode("node-1", job(Buffer.alloc(16, 43).toString("base64url"))),
            ).toBe(true);
          else if (exit === "closeStep") expect(manager.closeOperatorStep("step-1")).toBe("closed");
          else if (exit === "closeTerminal") manager.closeOperatorTerminal("node-1", terminalId);
          else if (exit === "cancelUser") manager.cancelOperatorTerminalsForUser("user-1");
          else if (exit === "failed")
            await manager.handleTextFrame(
              socket,
              result("succeeded", { status: "failed", error: "command_failed" }),
            );
          else await manager.handleTextFrame(socket, result(exit));
          expect(socket.last("protocol.error")).toBeUndefined();
          // Released now, not when the next timer would notice.
          expect(state.acceptanceRetries.size).toBe(0);
          expect(vi.getTimerCount() - base).toBe(0);
          const calls = handler.mock.calls.length;
          await vi.advanceTimersByTimeAsync(120_000);
          expect(handler).toHaveBeenCalledTimes(calls);
        } finally {
          vi.clearAllTimers();
          vi.useRealTimers();
          error.mockRestore();
        }
      },
    );

    it("R6-C-1: finished dispatches cannot pile up retries beyond the live trackers", async () => {
      const socket = await connect({ operatorTerminals: true });
      const handler = vi.fn(async (_ref: unknown, frame: { status: string }) => {
        if (frame.status === "operator_running") throw new Error("database down");
      });
      manager.setNodeFrameHandlers({ "runtime.job.result": handler });
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.useFakeTimers();
      // After the fake clock: it replaces the globals this wraps.
      const timers = trackAcceptanceTimers();
      try {
        const state = retryState(socket);
        for (let i = 0; i < 128; i++) {
          const id = Buffer.alloc(16);
          id.writeUInt32LE(i);
          const ids = { stepId: `churn-step-${i}`, terminalId: id.toString("base64url") };
          expect(manager.sendToNode("node-1", { ...job(ids.terminalId), stepId: ids.stepId })).toBe(
            true,
          );
          await manager.handleTextFrame(socket, result("awaiting_operator", ids));
          await manager.handleTextFrame(socket, result("operator_running", ids));
          // Each failed acceptance armed exactly its own retry timer...
          expect(timers.armed()).toBe(i + 1);
          expect(timers.live()).toBe(1);
          expect(state.acceptanceRetries.size).toBe(1);
          await manager.handleTextFrame(socket, result("succeeded", ids));
          // ...which its final clears at once, with the chain.
          expect(timers.live()).toBe(0);
          expect(state.acceptanceRetries.size).toBe(0);
        }
        expect(socket.last("protocol.error")).toBeUndefined();
        expect(state.operatorSteps.size).toBe(0);
        expect(state.acceptanceRetries.size).toBe(0);
        expect(timers.armed()).toBe(128);
        expect(timers.live()).toBe(0);
        expect(manager.operatorRoom("node-1")).toBe(true);
        const calls = handler.mock.calls.length;
        await vi.advanceTimersByTimeAsync(120_000);
        expect(handler).toHaveBeenCalledTimes(calls);
        expect(timers.armed()).toBe(128);
      } finally {
        timers.restore();
        vi.clearAllTimers();
        vi.useRealTimers();
        error.mockRestore();
      }
    });

    it("R6-C-1: a final releases the retry while its redelivery still awaits real I/O; the late failure does not reschedule", async () => {
      const io = await pendingRead();
      let retrySchedules: ReturnType<typeof countRetrySchedules> | undefined;
      const socket = await connect({ operatorTerminals: true });
      let calls = 0;
      const handler = vi.fn(async (_ref: unknown, frame: { status: string }) => {
        if (frame.status !== "operator_running") return;
        calls++;
        if (calls === 1) throw new Error("initial failure");
        await io.read;
        throw new Error("late retry failure");
      });
      manager.setNodeFrameHandlers({ "runtime.job.result": handler });
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.useFakeTimers();
      try {
        expect(manager.sendToNode("node-1", job())).toBe(true);
        await manager.handleTextFrame(socket, result("awaiting_operator"));
        retrySchedules = countRetrySchedules();
        await manager.handleTextFrame(socket, result("operator_running"));
        expect(retrySchedules.count()).toBe(1);
        await vi.advanceTimersByTimeAsync(1_000);
        // The retry is in flight (no timer), blocked on the pending read.
        expect(calls).toBe(2);
        expect(io.pending()).toBe(true);
        const state = retryState(socket);
        expect(state.acceptanceRetries.size).toBe(1);
        await manager.handleTextFrame(socket, result("succeeded"));
        expect(state.operatorSteps.size).toBe(0);
        expect(state.acceptanceRetries.size).toBe(0);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(io.pending()).toBe(true);
        await io.release();
        await vi.advanceTimersByTimeAsync(0);
        // The late failure finds its chain gone: no new entry, no new retry timer.
        expect(state.acceptanceRetries.size).toBe(0);
        expect(retrySchedules.count()).toBe(1);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(calls).toBe(2);
      } finally {
        // No late callback of this manager may outlive the test.
        manager.dispose();
        retrySchedules?.restore();
        vi.clearAllTimers();
        vi.useRealTimers();
        error.mockRestore();
        await io.stop();
      }
    }, 10_000);

    it("R6-C-1: an initial delivery that fails after its run ended starts no retry", async () => {
      const io = await pendingRead();
      let retrySchedules: ReturnType<typeof countRetrySchedules> | undefined;
      const socket = await connect({ operatorTerminals: true });
      const handler = vi.fn(async (_ref: unknown, frame: { status: string }) => {
        if (frame.status !== "operator_running") return;
        await io.read;
        throw new Error("late initial failure");
      });
      manager.setNodeFrameHandlers({ "runtime.job.result": handler });
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.useFakeTimers();
      try {
        expect(manager.sendToNode("node-1", job())).toBe(true);
        await manager.handleTextFrame(socket, result("awaiting_operator"));
        retrySchedules = countRetrySchedules();
        const initial = manager.handleTextFrame(socket, result("operator_running"));
        await manager.handleTextFrame(socket, result("succeeded"));
        const state = retryState(socket);
        expect(state.operatorSteps.size).toBe(0);
        await io.release();
        await initial;
        expect(state.acceptanceRetries.size).toBe(0);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(retrySchedules.count()).toBe(0);
        expect(handler).toHaveBeenCalledTimes(3);
      } finally {
        // No late callback of this manager may outlive the test.
        manager.dispose();
        retrySchedules?.restore();
        vi.clearAllTimers();
        vi.useRealTimers();
        error.mockRestore();
        await io.stop();
      }
    }, 10_000);

    it("R8-I1: through the composed handlers, a failed acceptance is still redelivered and later parts still run", async () => {
      const { composeNodeFrameHandlers } = await import("./node-frame-handlers.js");
      const socket = await connect({ operatorTerminals: true });
      let failures = 1;
      const failing = vi.fn(async (_ref: unknown, frame: { status: string }) => {
        if (frame.status === "operator_running" && failures-- > 0)
          throw new Error("injected persistence failure");
      });
      const later = vi.fn();
      manager.setNodeFrameHandlers(
        composeNodeFrameHandlers(
          { "runtime.job.result": failing },
          { "runtime.job.result": later },
        ),
      );
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.useFakeTimers();
      const running = (mock: typeof failing | typeof later) =>
        mock.mock.calls.filter(
          ([, frame]) => (frame as { status: string }).status === "operator_running",
        );
      try {
        expect(manager.sendToNode("node-1", job())).toBe(true);
        await manager.handleTextFrame(socket, result("awaiting_operator"));
        await manager.handleTextFrame(socket, result("operator_running"));
        expect(socket.last("protocol.error")).toBeUndefined();
        // The failing part did not starve the next one.
        expect(running(later)).toHaveLength(1);
        const state = retryState(socket);
        expect(state.operatorSteps.size).toBe(1);
        expect(state.acceptanceRetries.size).toBe(1);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(running(failing)).toHaveLength(2);
        expect(running(later)).toHaveLength(2);
        expect(state.acceptanceRetries.size).toBe(0);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(running(failing)).toHaveLength(2);
      } finally {
        manager.dispose();
        vi.clearAllTimers();
        vi.useRealTimers();
        error.mockRestore();
      }
    });

    it("R8-I1: the installed node wiring redelivers an acceptance the lifecycle failed to record", async () => {
      const wiring = await import("./node-wiring.js");
      const { relaySessionManager } = await import("./session-manager.js");
      // The handlers production installs, handed to this test's manager.
      const install = vi
        .spyOn(relaySessionManager, "setNodeFrameHandlers")
        .mockImplementation((handlers) => manager.setNodeFrameHandlers(handlers));
      let failures = 1;
      const record = vi
        .spyOn(wiring.runtimeLifecycle, "handleJobResult")
        .mockImplementation(async (_ref, frame) => {
          if (frame.status === "operator_running" && failures-- > 0)
            throw new Error("injected persistence failure");
        });
      const socket = await connect({ operatorTerminals: true });
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.useFakeTimers();
      const running = () =>
        record.mock.calls.filter(([, frame]) => frame.status === "operator_running");
      try {
        wiring.installNodeFrameHandlers();
        expect(install).toHaveBeenCalledTimes(1);
        expect(manager.sendToNode("node-1", job())).toBe(true);
        await manager.handleTextFrame(socket, result("awaiting_operator"));
        await manager.handleTextFrame(socket, result("operator_running"));
        expect(socket.last("protocol.error")).toBeUndefined();
        const state = retryState(socket);
        expect(state.acceptanceRetries.size).toBe(1);
        expect(running()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(running()).toHaveLength(2);
        expect(state.acceptanceRetries.size).toBe(0);
      } finally {
        manager.dispose();
        vi.clearAllTimers();
        vi.useRealTimers();
        error.mockRestore();
        record.mockRestore();
        install.mockRestore();
      }
    });

    it("drops progress for a terminal it did not send, and closes it on the node", async () => {
      const socket = await connect({ operatorTerminals: true });
      const handler = vi.fn();
      manager.setNodeFrameHandlers({ "runtime.job.result": handler });
      const stray = Buffer.alloc(16, 6).toString("base64url");
      await manager.handleTextFrame(socket, result("awaiting_operator", { terminalId: stray }));
      expect(handler).not.toHaveBeenCalled();
      expect(socket.last("term.close")).toEqual({ type: "term.close", terminalId: stray });
      // A final always goes on (the engine checks the stored terminal id).
      await manager.handleTextFrame(socket, result("succeeded", { terminalId: stray }));
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("keeps operator terminals when trust lowers; a server close ends them", async () => {
      const socket = await connect({ operatorTerminals: true });
      const handler = vi.fn();
      manager.setNodeFrameHandlers({ "runtime.job.result": handler });
      expect(manager.sendToNode("node-1", job())).toBe(true);
      await manager.handleTextFrame(socket, result("awaiting_operator"));
      manager.requestTrustLower("node-1", new Date());
      expect(manager.operatorStepTerminal("step-1", "user-1")).not.toBeNull();
      // Ids are never reused, and one step has one terminal.
      expect(manager.sendToNode("node-1", { ...job(), stepId: "step-9" })).toBe(false);

      expect(manager.closeOperatorStep("step-1", { keepRunning: true })).toBe("closed");
      expect(socket.last("term.close")).toEqual({ type: "term.close", terminalId });
      expect(manager.operatorStepTerminal("step-1", "user-1")).toBeNull();
      expect(manager.closeOperatorStep("step-1")).toBe("absent");
      // The node's answer to the close still reaches the engine; a late screen does not.
      await manager.handleTextFrame(socket, result("awaiting_operator"));
      expect(handler).toHaveBeenCalledTimes(1);
      await manager.handleTextFrame(socket, result("operator_closed"));
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("closes a replaced terminal on the node, and terminals no step owns", async () => {
      const socket = await connect({ operatorTerminals: true });
      expect(manager.sendToNode("node-1", job())).toBe(true);
      await manager.handleTextFrame(socket, result("awaiting_operator"));
      // The step's next dispatch names a fresh terminal: the old one is closed on the node.
      const fresh = Buffer.alloc(16, 7).toString("base64url");
      expect(manager.sendToNode("node-1", job(fresh))).toBe(true);
      expect(socket.json().filter((frame) => frame.type === "term.close")).toEqual([
        { type: "term.close", terminalId },
      ]);
      // A live terminal id is never sent for another step.
      expect(manager.sendToNode("node-1", { ...job(fresh), stepId: "step-2" })).toBe(false);
      // The engine dropped an answer naming the fresh terminal: it is closed too.
      manager.closeOperatorTerminal("node-1", fresh);
      expect(socket.last("term.close")).toEqual({ type: "term.close", terminalId: fresh });
      expect(manager.operatorStepTerminal("step-1", "user-1")).toBeNull();
      // One nothing tracks is closed on the node directly.
      const stray = Buffer.alloc(16, 8).toString("base64url");
      manager.closeOperatorTerminal("node-1", stray);
      expect(socket.last("term.close")).toEqual({ type: "term.close", terminalId: stray });
    });

    it("attaches nobody when the session holding the terminal is another owner's", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const socket = await connect({ operatorTerminals: true });
        expect(manager.sendToNode("node-1", job())).toBe(true);
        await manager.handleTextFrame(socket, result("awaiting_operator"));
        expect(manager.operatorStepTerminal("step-1", "user-1")).not.toBeNull();
        // A slip elsewhere left user-1's step and terminal on a session of user-2's.
        const sessions = (
          manager as unknown as {
            sessionsByNodeId: Map<string, { identity: NodeIdentity }>;
          }
        ).sessionsByNodeId;
        const live = sessions.get("node-1");
        if (!live) throw new Error("no session");
        live.identity = { ...live.identity, userId: "user-2" };
        const sendsBefore = socket.sends.length;
        expect(manager.operatorStepTerminal("step-1", "user-1")).toBeNull();
        expect(manager.attachOperatorTerminal(attach)).toEqual({ ok: false, error: "not_found" });
        expect(socket.sends.length).toBe(sendsBefore);
        expect(warn.mock.calls).toEqual([
          ["[relay] refused a send to a node of another owner", "operator_attach"],
          ["[relay] refused a send to a node of another owner", "terminal_attach"],
        ]);
      } finally {
        warn.mockRestore();
      }
    });

    it("closes the user's operator terminals on a ban", async () => {
      const socket = await connect({ operatorTerminals: true });
      expect(manager.sendToNode("node-1", job())).toBe(true);
      await manager.handleTextFrame(socket, result("awaiting_operator"));
      manager.cancelOperatorTerminalsForUser("user-1");
      expect(socket.last("term.close")).toEqual({ type: "term.close", terminalId });
      expect(manager.operatorStepTerminal("step-1", "user-1")).toBeNull();
    });
  });
});
