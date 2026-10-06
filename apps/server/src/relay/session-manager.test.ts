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
const { RelaySessionManager } = await import("./session-manager.js");
const { observeRuntimeLoadRollup } = await import("./runtime-load-rollup.js");

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
  overrides: { trust?: "full" | "relay"; signature?: string } = {},
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
      operatorTerminals: false,
      files: { roots: ["/home/me"], asRoot: false },
      runtimeHosts: [],
      mediaExpand: false,
      liveStt: false,
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
    expect(session).toEqual({ connectionGeneration: generation, trust: "full" });
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
      files: { roots: ["/home/me"], asRoot: false },
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
      expect.objectContaining({ instanceId: "inst-2", nodeId: "node-1", running: 1 }),
    );
    expect(manager.getLiveNodeTelemetry(["node-1"]).get("node-1")?.runtimeLoad).toEqual([
      expect.objectContaining({ endpointSlug: "llama", instanceId: "inst-2" }),
    ]);
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
});
