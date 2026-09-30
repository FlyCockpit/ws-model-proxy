import type { CliWebsocketIdentity } from "@ws-model-proxy/api/lib/cli-credential-access";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseMultipartToSpool } from "../model-api/multipart-form-data.js";
import {
  encodeRelayBinaryFrame,
  parseRelayBinaryFrame,
  parseRelayClientControlFrame,
  RELAY_REQUEST_BODY_WINDOW_CHUNKS,
  RELAY_STALE_AFTER_MS,
  RELAY_UPGRADE_REQUIRED_MESSAGE,
} from "./protocol.js";
import { inventoryDigestFor, persistRelayRegistration } from "./registration.js";

const WS_READY_STATE_OPEN = 1;

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    MODEL_API_TRANSCRIPTION_MAX_UPLOAD_BYTES: 1024 * 1024,
    MODEL_API_TRANSCRIPTION_MAX_SPOOL_BYTES: 4 * 1024 * 1024,
    MODEL_API_TRANSCRIPTION_MAX_CONCURRENT_UPLOADS: 4,
    MODEL_API_TRANSCRIPTION_MIN_FREE_BYTES: 0,
    MODEL_API_TRANSCRIPTION_UPLOAD_TIMEOUT_MS: 30_000,
    MODEL_API_TRANSCRIPTION_STALE_SPOOL_MS: 24 * 60 * 60 * 1000,
  },
}));

const { RelaySessionManager } = await import("./session-manager.js");
const { default: prisma } = await import("@ws-model-proxy/db");

const db = prisma as unknown as {
  $transaction: MockInstance;
  user: {
    findUnique: MockInstance;
  };
  cliDevice: {
    upsert: MockInstance;
    update: MockInstance;
    updateMany: MockInstance;
  };
  cliToken: {
    update: MockInstance;
    updateMany: MockInstance;
    findUnique: MockInstance;
  };
  endpoint: {
    upsert: MockInstance;
    findUnique: MockInstance;
    findMany: MockInstance;
    updateMany: MockInstance;
  };
  discoveredModel: {
    findUnique: MockInstance;
    findMany: MockInstance;
    upsert: MockInstance;
    updateMany: MockInstance;
  };
  poolMember: {
    findMany: MockInstance;
    updateMany: MockInstance;
  };
  executionTarget: {
    findMany: MockInstance;
    findUnique: MockInstance;
  };
  inferenceCapacity: {
    findMany: MockInstance;
  };
};

class FakeSocket {
  readyState = WS_READY_STATE_OPEN;
  bufferedAmount = 0;
  sends: (string | ArrayBuffer | Uint8Array)[] = [];
  closes: { code?: number; reason?: string }[] = [];

  send(data: string | ArrayBuffer | Uint8Array) {
    this.sends.push(data);
  }

  close(code?: number, reason?: string) {
    this.closes.push({ code, reason });
    this.readyState = 3;
  }
}

const identity: CliWebsocketIdentity = {
  kind: "cliToken",
  id: "token-id",
  userId: "user-id",
  cliDeviceId: null,
  lookupPrefix: "wsmp_cli_lookup",
};

const now = new Date("2026-01-01T00:00:00.000Z");

/** Holds the next registration transaction until `release()`. */
function holdNextRegistration() {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reportStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    reportStarted = resolve;
  });
  db.$transaction.mockImplementationOnce(async (callback: (tx: typeof db) => unknown) => {
    reportStarted?.();
    await gate;
    return callback(db);
  });
  return { started, release: () => release?.() };
}

function capabilities26(features?: {
  humanTerminal?: boolean;
  mcpCommandMode?: "off" | "supervised" | "unsupervised";
  terminalApproval?: boolean;
  terminalSupported?: boolean;
}) {
  return {
    protocolVersion: "2.8",
    inventoryAck: true,
    inventoryReplace: true,
    endpointTargeting: true,
    binaryFrames: true,
    cancellation: true,
    maxBinaryChunkBytes: 1024 * 1024,
    requestBodyStreaming: true,
    requestBodyWindowChunks: RELAY_REQUEST_BODY_WINDOW_CHUNKS,
    sharedTokenizerTps: true,
    standardizedMetrics: true,
    terminal: true,
    exec: true,
    features: {
      humanTerminal: features?.humanTerminal ?? true,
      mcpCommandMode: features?.mcpCommandMode ?? "unsupervised",
      terminalApproval: features?.terminalApproval ?? false,
      terminalSupported: features?.terminalSupported ?? true,
      remoteMetricSources: false,
      mcpFileRead: false,
      fileRootsConfigured: false,
      allowFileToolsAsRoot: false,
    },
    terminalPublicKey: uncompressedKey(),
    terminalViewers: true,
    supervisedCommands: true,
    nodeTelemetry: true,
    fileOps: true,
  };
}

function helloFrame() {
  return JSON.stringify({
    type: "hello",
    id: "hello-id",
    protocolVersion: "2.8",
    cli: {
      slug: "desktop",
      hostname: "desk-01.local",
      capabilities: {
        ...capabilities26(),
      },
    },
    endpoints: [
      {
        slug: "local-openai",
        label: "Local OpenAI",
        kind: "openai-compatible",
        status: "online",
        defaultCapabilities: {
          version: 1,
          protocol: "openai-compatible",
          chatCompletions: { supported: true, streaming: true, vision: true },
          embeddings: { supported: true },
          responses: { supported: true, statefulFollowUps: true },
          audio: { transcriptions: true, speech: true },
        },
        models: [
          {
            slug: "llava-local",
            upstreamModelId: "llava/local",
            capabilityOverrideMode: "override",
            capabilities: {
              version: 1,
              protocol: "openai-compatible",
              chatCompletions: { supported: true, vision: true },
            },
          },
        ],
      },
    ],
  });
}

function seedRegistrationMocks() {
  db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) => callback(db));
  // An unbound CLI token: every hello's conditional bind claims it.
  db.cliToken.findUnique.mockResolvedValue({ revokedAt: null, expiresAt: null, cliDeviceId: null });
  db.cliToken.updateMany.mockResolvedValue({ count: 1 });
  db.user.findUnique.mockResolvedValue({ id: "user-id", slug: "owner" });
  db.cliDevice.upsert.mockResolvedValue({
    id: "cli-device-id",
    userId: "user-id",
    slug: "desktop",
    connectionGeneration: 1,
  });
  db.cliToken.update.mockResolvedValue({ id: "token-id" });
  db.cliDevice.update.mockResolvedValue({
    inventorySeq: 1,
    inventoryDigest: "digest",
    inventoryAcknowledgedAt: now,
    id: "cli-device-id",
  });
  db.cliDevice.updateMany.mockResolvedValue({ count: 1 });
  db.endpoint.findUnique.mockResolvedValue(null);
  db.endpoint.findMany.mockResolvedValue([]);
  db.endpoint.upsert.mockResolvedValue({ id: "endpoint-id", slug: "local-openai" });
  db.endpoint.updateMany.mockResolvedValue({ count: 0 });
  db.discoveredModel.findUnique.mockResolvedValue(null);
  db.discoveredModel.findMany.mockResolvedValue([]);
  db.discoveredModel.upsert.mockResolvedValue({ id: "model-id" });
  db.discoveredModel.updateMany.mockResolvedValue({ count: 0 });
  db.poolMember.findMany.mockResolvedValue([{ id: "pool-member-id" }]);
  db.poolMember.updateMany.mockResolvedValue({ count: 1 });
  db.executionTarget.findMany.mockResolvedValue([{ id: "execution-target-id" }]);
  db.executionTarget.findUnique.mockResolvedValue({
    id: "execution-target-id",
    inferenceCapacityId: "capacity-id",
  });
  db.inferenceCapacity.findMany.mockResolvedValue([]);
}

describe("relay drain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedRegistrationMocks();
  });

  it("closes every CLI socket before a stalled disconnect write can block the rest", async () => {
    const manager = new RelaySessionManager();
    const first = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket: first, identity, now });
    await manager.handleTextFrame(first, helloFrame(), now);
    db.cliDevice.upsert.mockResolvedValueOnce({
      id: "second-device",
      userId: "user-id",
      slug: "laptop",
    });
    const second = new FakeSocket();
    manager.acceptAuthenticatedSocket({
      socket: second,
      identity: { ...identity, id: "token-2" },
      now,
    });
    await manager.handleTextFrame(second, helloFrame(), now);
    expect(manager.getActiveCliDeviceIds()).toHaveLength(2);

    db.cliDevice.updateMany.mockImplementation(() => new Promise(() => {}));
    const closing = manager.closeRelaySessions(now);
    let settled = false;
    void closing.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(manager.isDraining()).toBe(true);
    expect(first.closes).toEqual([{ code: 1001, reason: "shutdown" }]);
    expect(second.closes).toEqual([{ code: 1001, reason: "shutdown" }]);
    expect(manager.getActiveCliDeviceIds()).toEqual([]);
    expect(settled).toBe(false);
    manager.dispose();
  });

  it("refuses a socket accepted after the drain began: shutdown close, never registered", async () => {
    const manager = new RelaySessionManager();
    const late = new FakeSocket();
    manager.beginDrain();
    expect(manager.acceptAuthenticatedSocket({ socket: late, identity, now })).toBe(false);
    expect(late.closes).toEqual([{ code: 1001, reason: "shutdown" }]);
    // Not registered: its frames are an unknown socket, and no unregistered timer runs.
    await expect(manager.handleTextFrame(late, helloFrame(), now)).rejects.toThrow(
      "Unknown relay socket.",
    );
    expect(manager.getActiveCliDeviceIds()).toEqual([]);
    // A socket that was already closed is not closed twice.
    const gone = new FakeSocket();
    gone.readyState = 3;
    expect(manager.acceptAuthenticatedSocket({ socket: gone, identity, now })).toBe(false);
    expect(gone.closes).toEqual([]);
    manager.dispose();
  });

  it("closes idle CLI sockets and keeps a socket until its model request finishes", async () => {
    const manager = new RelaySessionManager();
    const idle = new FakeSocket();
    const pending = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket: idle, identity, now });
    await manager.handleTextFrame(idle, helloFrame(), now);
    manager.acceptAuthenticatedSocket({ socket: pending, identity, now });

    db.cliDevice.upsert.mockResolvedValueOnce({
      id: "busy-device",
      userId: "user-id",
      slug: "laptop",
    });
    const busy = new FakeSocket();
    manager.acceptAuthenticatedSocket({
      socket: busy,
      identity: { ...identity, id: "token-2" },
      now,
    });
    await manager.handleTextFrame(busy, helloFrame(), now);
    manager.registerRelayResponseHandlers({
      cliDeviceId: "busy-device",
      requestId: "request-id",
      handlers: {
        onHeaders() {},
        onBody() {},
        onComplete() {},
        onError() {},
        onCancelled() {},
      },
    });

    await manager.closeIdleRelaySessions(now);

    expect(idle.closes).toEqual([{ code: 1001, reason: "shutdown" }]);
    expect(pending.closes).toEqual([{ code: 1001, reason: "shutdown" }]);
    expect(busy.closes).toEqual([]);
    expect(manager.getActiveCliDeviceIds()).toEqual(["busy-device"]);

    await manager.handleTextFrame(
      busy,
      JSON.stringify({ type: "relay.complete", requestId: "request-id" }),
      now,
    );
    expect(busy.closes).toEqual([{ code: 1001, reason: "shutdown" }]);
    expect(manager.getActiveCliDeviceIds()).toEqual([]);
    expect(() =>
      manager.sendRelayRequest({
        cliDeviceId: "busy-device",
        endpointSlug: "local-openai",
        requestId: "later",
        family: "generic",
        method: "POST",
        path: "/v1/chat/completions",
        headers: {},
        timeoutMs: 1000,
      }),
    ).toThrow(/disconnected/);
  });
});

describe("revoked credentials", () => {
  const credentials = prisma as unknown as { cliDeviceCredential: { findUnique: MockInstance } };
  const deviceIdentity = (id: string): CliWebsocketIdentity => ({
    kind: "deviceCredential",
    id,
    userId: "user-id",
    cliDeviceId: "cli-device-id",
    lookupPrefix: `wsmp_device_${id}`,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    seedRegistrationMocks();
    credentials.cliDeviceCredential.findUnique.mockResolvedValue({
      revokedAt: null,
      cliDeviceId: "cli-device-id",
    });
  });

  it("closes registered and unregistered sockets of revoked credentials only", async () => {
    const manager = new RelaySessionManager();
    const registered = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket: registered, identity: deviceIdentity("old"), now });
    await manager.handleTextFrame(registered, helloFrame(), now);
    const unregistered = new FakeSocket();
    manager.acceptAuthenticatedSocket({
      socket: unregistered,
      identity: deviceIdentity("old-2"),
      now,
    });
    // Same id, other kind: a CLI token is a different credential.
    const token = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket: token, identity: { ...identity, id: "old" }, now });
    const current = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket: current, identity: deviceIdentity("new"), now });
    expect(manager.getActiveCliDeviceIds()).toEqual(["cli-device-id"]);

    const revokedAt = new Date("2026-01-01T00:01:00.000Z");
    await manager.closeSessionsForRevokedCredentials(
      { kind: "deviceCredential", ids: ["old", "old-2"] },
      revokedAt,
    );

    expect(registered.closes).toEqual([{ code: 1008, reason: "access_denied" }]);
    expect(unregistered.closes).toEqual([{ code: 1008, reason: "access_denied" }]);
    expect(JSON.parse(String(registered.sends.at(-1)))).toMatchObject({
      type: "protocol.error",
      message: "access_denied",
    });
    expect(token.closes).toEqual([]);
    expect(current.closes).toEqual([]);
    expect(manager.getActiveCliDeviceIds()).toEqual([]);
    expect(db.cliDevice.updateMany).toHaveBeenCalledWith({
      where: { id: "cli-device-id", connectionGeneration: 1 },
      data: { status: "DISCONNECTED", lastDisconnectedAt: revokedAt },
    });
    manager.dispose();
  });

  it("closes every live session of a deleted user by identity userId, any credential", async () => {
    const manager = new RelaySessionManager();
    const registered = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket: registered, identity: deviceIdentity("old"), now });
    await manager.handleTextFrame(registered, helloFrame(), now);
    // Minted after any snapshot a caller could have taken: still the user's.
    const mintedLater = new FakeSocket();
    manager.acceptAuthenticatedSocket({
      socket: mintedLater,
      identity: deviceIdentity("minted-after-snapshot"),
      now,
    });
    const userToken = new FakeSocket();
    manager.acceptAuthenticatedSocket({
      socket: userToken,
      identity: { ...identity, id: "token-x", userId: "user-id" },
      now,
    });
    const otherUser = new FakeSocket();
    manager.acceptAuthenticatedSocket({
      socket: otherUser,
      identity: { ...deviceIdentity("other"), userId: "other-user-id" },
      now,
    });

    const deletedAt = new Date("2026-01-01T00:02:00.000Z");
    await manager.closeSessionsForUser("user-id", deletedAt);

    for (const socket of [registered, mintedLater, userToken])
      expect(socket.closes).toEqual([{ code: 1008, reason: "access_denied" }]);
    expect(otherUser.closes).toEqual([]);
    expect(manager.getActiveCliDeviceIds()).toEqual([]);
    expect(db.cliDevice.updateMany).toHaveBeenCalledWith({
      where: { id: "cli-device-id", connectionGeneration: 1 },
      data: { status: "DISCONNECTED", lastDisconnectedAt: deletedAt },
    });
    manager.dispose();
  });

  it("refuses a hello from a credential revoked after its websocket authenticated", async () => {
    credentials.cliDeviceCredential.findUnique.mockResolvedValue({
      revokedAt: now,
      cliDeviceId: "cli-device-id",
    });
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket, identity: deviceIdentity("old"), now });

    await manager.handleTextFrame(socket, helloFrame(), now);

    expect(socket.closes).toEqual([{ code: 1008, reason: "access_denied" }]);
    expect(manager.getActiveCliDeviceIds()).toEqual([]);
    manager.dispose();
  });

  it("closes the socket when an inventory update finds the credential revoked", async () => {
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket, identity: deviceIdentity("old"), now });
    await manager.handleTextFrame(socket, helloFrame(), now);
    expect(manager.getActiveCliDeviceIds()).toEqual(["cli-device-id"]);

    // Revoked where this process's hook could not reach (another replica).
    credentials.cliDeviceCredential.findUnique.mockResolvedValue({
      revokedAt: now,
      cliDeviceId: "cli-device-id",
    });
    const hello = JSON.parse(helloFrame()) as { endpoints: unknown[] };
    await manager.handleTextFrame(
      socket,
      JSON.stringify({ type: "inventory.update", id: "inv-1", endpoints: hello.endpoints }),
      now,
    );

    expect(socket.closes).toEqual([{ code: 1008, reason: "access_denied" }]);
    expect(manager.getActiveCliDeviceIds()).toEqual([]);
    manager.dispose();
  });

  const disconnectedWrites = () =>
    db.cliDevice.updateMany.mock.calls.filter(
      ([args]) => (args as { data?: { status?: string } }).data?.status === "DISCONNECTED",
    );

  it("keeps a hello out of routing when a revoke closes its socket mid-registration", async () => {
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket, identity: deviceIdentity("old"), now });
    const held = holdNextRegistration();
    const hello = manager.handleTextFrame(socket, helloFrame(), now);
    await held.started;

    // The revoke commits and its hook closes the (still unregistered) socket.
    await manager.closeSessionsForRevokedCredentials({ kind: "deviceCredential", ids: ["old"] });
    expect(socket.closes).toEqual([{ code: 1008, reason: "access_denied" }]);
    // The registration itself then commits (it re-checked before the revoke).
    held.release();
    await hello;

    expect(manager.getActiveCliDeviceIds()).toEqual([]);
    expect(socket.sends.some((send) => String(send).includes('"hello.ok"'))).toBe(false);
    // Registration wrote CONNECTED for a session that no longer exists: undone,
    // under the generation that registration itself accepted.
    expect(disconnectedWrites()).toEqual([
      [
        {
          where: { id: "cli-device-id", connectionGeneration: 1 },
          data: { status: "DISCONNECTED", lastDisconnectedAt: now },
        },
      ],
    ]);

    // A later CLI for the device registers and is not evicted by the dead one.
    const current = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket: current, identity: deviceIdentity("new"), now });
    await manager.handleTextFrame(current, helloFrame(), now);
    expect(manager.getActiveCliDeviceIds()).toEqual(["cli-device-id"]);
    expect(current.closes).toEqual([]);
    manager.dispose();
  });

  it("keeps a hello out of routing when its socket closes mid-registration", async () => {
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket, identity: deviceIdentity("old"), now });
    const held = holdNextRegistration();
    const hello = manager.handleTextFrame(socket, helloFrame(), now);
    await held.started;

    await manager.removeSession(socket, now);
    held.release();
    await hello;

    expect(manager.getActiveCliDeviceIds()).toEqual([]);
    expect(socket.sends).toEqual([]);
    expect(disconnectedWrites()).toHaveLength(1);
    manager.dispose();
  });

  it("leaves the device status to a live session that took over during the detached hello", async () => {
    const manager = new RelaySessionManager();
    const stale = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket: stale, identity: deviceIdentity("old"), now });
    const held = holdNextRegistration();
    const hello = manager.handleTextFrame(stale, helloFrame(), now);
    await held.started;
    await manager.removeSession(stale, now);

    const current = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket: current, identity: deviceIdentity("new"), now });
    await manager.handleTextFrame(current, helloFrame(), now);
    held.release();
    await hello;

    expect(manager.getActiveCliDeviceIds()).toEqual(["cli-device-id"]);
    expect(current.closes).toEqual([]);
    expect(disconnectedWrites()).toEqual([]);
    manager.dispose();
  });

  describe("device generation follows commit order, owners follow hello order", () => {
    /** A stateful CliDevice row: upsert bumps the generation, updateMany applies only on a match. */
    function modelDeviceRow() {
      const row = { generation: 0, status: "CONNECTED" };
      db.cliDevice.upsert.mockImplementation(async () => {
        row.generation += 1;
        row.status = "CONNECTED";
        return {
          id: "cli-device-id",
          userId: "user-id",
          slug: "desktop",
          connectionGeneration: row.generation,
        };
      });
      db.cliDevice.updateMany.mockImplementation(async (arg) => {
        const { where, data } = arg as {
          where: { connectionGeneration?: number };
          data: { status?: string };
        };
        if (
          where.connectionGeneration !== undefined &&
          where.connectionGeneration !== row.generation
        )
          return { count: 0 };
        if (data.status) row.status = data.status;
        return { count: 1 };
      });
      return row;
    }

    // Each row: which hello ends up detached, and whether it commits before
    // or after the live owner's hello. Every row leaves the row CONNECTED
    // with a stale owner fence on the old code; the owner's own later
    // disconnect must still be recorded.
    it.each([
      {
        name: "a detached hello commits above a live owner that predates it",
        run: async (m: InstanceType<typeof RelaySessionManager>, owner: FakeSocket) => {
          const detached = new FakeSocket();
          m.acceptAuthenticatedSocket({ socket: detached, identity, now });
          const held = holdNextRegistration();
          const hello = m.handleTextFrame(detached, helloFrame(), now);
          await held.started;
          await m.removeSession(detached, now);
          held.release();
          await hello;
          return owner;
        },
        ownerFirst: true,
      },
      {
        name: "a detached hello commits after the owner's hello took over",
        run: async (m: InstanceType<typeof RelaySessionManager>) => {
          const detached = new FakeSocket();
          m.acceptAuthenticatedSocket({ socket: detached, identity: deviceIdentity("old"), now });
          const held = holdNextRegistration();
          const hello = m.handleTextFrame(detached, helloFrame(), now);
          await held.started;
          await m.removeSession(detached, now);
          const current = new FakeSocket();
          m.acceptAuthenticatedSocket({ socket: current, identity: deviceIdentity("new"), now });
          await m.handleTextFrame(current, helloFrame(), now);
          held.release();
          await hello;
          return current;
        },
        ownerFirst: false,
      },
    ])("records the owner's disconnect when $name", async ({ run, ownerFirst }) => {
      const row = modelDeviceRow();
      const manager = new RelaySessionManager();
      const first = new FakeSocket();
      if (ownerFirst) {
        manager.acceptAuthenticatedSocket({ socket: first, identity, now });
        await manager.handleTextFrame(first, helloFrame(), now);
      }
      const owner = await run(manager, first);
      expect(manager.getActiveCliDeviceIds()).toEqual(["cli-device-id"]);
      // The detached registration committed above the owner's accepted generation.
      expect(row.generation).toBe(2);

      const closedAt = new Date(now.getTime() + 2_000);
      await manager.removeSession(owner, closedAt);

      expect(manager.getActiveCliDeviceIds()).toEqual([]);
      expect(row.status).toBe("DISCONNECTED");
      expect(db.cliDevice.updateMany).toHaveBeenLastCalledWith({
        where: { id: "cli-device-id", connectionGeneration: 2 },
        data: { status: "DISCONNECTED", lastDisconnectedAt: closedAt },
      });
      manager.dispose();
    });
  });

  it("does not let an older hello result replace a newer committed owner", async () => {
    // Hello results complete out of order: generation 2 commits but its
    // continuation is delayed; generation 3 commits and installs. The older
    // result must not close the newer socket or take ownership, or the newer
    // owner's disconnect (fenced at 3) would be the one refused later.
    const row = { generation: 0, status: "CONNECTED" };
    db.cliDevice.upsert.mockImplementation(async () => {
      row.generation += 1;
      return {
        id: "cli-device-id",
        userId: "user-id",
        slug: "desktop",
        connectionGeneration: row.generation,
      };
    });
    db.cliDevice.updateMany.mockImplementation(async (arg) => {
      const { where, data } = arg as {
        where: { connectionGeneration?: number };
        data: { status?: string };
      };
      if (where.connectionGeneration !== undefined && where.connectionGeneration !== row.generation)
        return { count: 0 };
      if (data.status) row.status = data.status;
      return { count: 1 };
    });
    const manager = new RelaySessionManager();
    const older = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket: older, identity: deviceIdentity("old"), now });
    let releaseOlder: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseOlder = resolve;
    });
    db.$transaction.mockImplementationOnce(async (callback: (tx: typeof db) => unknown) => {
      const committed = await callback(db);
      await gate; // committed at generation 1, result returned late
      return committed;
    });
    const olderHello = manager.handleTextFrame(older, helloFrame(), now);
    await vi.waitFor(() => expect(row.generation).toBe(1));

    const newer = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket: newer, identity: deviceIdentity("new"), now });
    await manager.handleTextFrame(newer, helloFrame(), now);
    expect(row.generation).toBe(2);
    releaseOlder();
    await olderHello;

    expect(newer.closes).toEqual([]);
    expect(older.closes).toEqual([{ code: 1000, reason: "replaced" }]);
    expect(manager.getActiveCliDeviceIds()).toEqual(["cli-device-id"]);
    expect(older.sends.some((frame) => String(frame).includes("hello.ok"))).toBe(false);

    await manager.removeSession(newer, new Date(now.getTime() + 1_000));
    expect(row.status).toBe("DISCONNECTED");
    expect(manager.getActiveCliDeviceIds()).toEqual([]);
    manager.dispose();
  });

  it("does not attribute a recovery probe's disconnect to the member when a reconnect replaced its session", async () => {
    const manager = new RelaySessionManager();
    const probe = (
      manager as unknown as {
        probeOwnedPoolMember(member: unknown): Promise<boolean | "superseded">;
      }
    ).probeOwnedPoolMember.bind(manager);
    const member = {
      id: "member-1",
      cliDeviceId: "cli-device-id",
      endpointSlug: "local-openai",
      upstreamModelId: "model-a",
      userId: "user-id",
      capabilities: {
        version: 1,
        protocol: "openai-compatible",
        chatCompletions: { supported: true },
      },
    };
    const first = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket: first, identity: deviceIdentity("a"), now });
    await manager.handleTextFrame(first, helloFrame(), now);

    const probing = probe(member);
    // The CLI reconnects before the server saw the old close: the replacement
    // fails the probe's request with `disconnected` and maps the device to the
    // new session.
    const second = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket: second, identity: deviceIdentity("b"), now });
    await manager.handleTextFrame(second, helloFrame(), now);
    expect(first.closes).toEqual([{ code: 1000, reason: "replaced" }]);

    await expect(probing).resolves.toBe("superseded");
    manager.dispose();
  });

  it("does not attribute a probe's disconnect after its headers arrived when a reconnect replaced it", async () => {
    const manager = new RelaySessionManager();
    const probe = (
      manager as unknown as {
        probeOwnedPoolMember(member: unknown): Promise<boolean | "superseded">;
      }
    ).probeOwnedPoolMember.bind(manager);
    const member = {
      id: "member-1",
      cliDeviceId: "cli-device-id",
      endpointSlug: "local-openai",
      upstreamModelId: "model-a",
      userId: "user-id",
      capabilities: {
        version: 1,
        protocol: "openai-compatible",
        chatCompletions: { supported: true },
      },
    };
    const first = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket: first, identity: deviceIdentity("a"), now });
    await manager.handleTextFrame(first, helloFrame(), now);

    const probing = probe(member);
    await vi.waitFor(() =>
      expect(
        first.sends.some((frame) => typeof frame === "string" && frame.includes("relay.request")),
      ).toBe(true),
    );
    const request = first.sends
      .filter((frame): frame is string => typeof frame === "string")
      .map((frame) => JSON.parse(frame) as { type: string; requestId?: string })
      .find((frame) => frame.type === "relay.request");
    await manager.handleTextFrame(
      first,
      JSON.stringify({
        type: "relay.response.headers",
        requestId: request?.requestId,
        status: 200,
        headers: {},
      }),
      now,
    );
    const second = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket: second, identity: deviceIdentity("b"), now });
    await manager.handleTextFrame(second, helloFrame(), now);

    await expect(probing).resolves.toBe("superseded");
    manager.dispose();
  });

  it("does not probe when the owning session is gone at dispatch", async () => {
    const manager = new RelaySessionManager();
    const probe = (
      manager as unknown as {
        probeOwnedPoolMember(member: unknown): Promise<boolean | "superseded">;
      }
    ).probeOwnedPoolMember.bind(manager);
    await expect(
      probe({
        id: "member-1",
        cliDeviceId: "no-such-device",
        endpointSlug: "local-openai",
        upstreamModelId: "model-a",
        userId: "user-id",
        capabilities: {
          version: 1,
          protocol: "openai-compatible",
          chatCompletions: { supported: true },
        },
      }),
    ).resolves.toBe("superseded");
    manager.dispose();
  });

  it("does not install an older hello over a newer generation that was detached and settled first", async () => {
    // A commits generation 1 but its result is delayed. B commits generation 2
    // and its socket closes mid-registration, so B settles (no owner installed
    // yet) and records the device DISCONNECTED at generation 2. When A resumes
    // it must not become the owner: its heartbeats (fenced at generation 1)
    // would be refused forever while the row says DISCONNECTED.
    const row = { generation: 0, status: "CONNECTED" };
    db.cliDevice.upsert.mockImplementation(async () => {
      row.generation += 1;
      row.status = "CONNECTED";
      return {
        id: "cli-device-id",
        userId: "user-id",
        slug: "desktop",
        connectionGeneration: row.generation,
      };
    });
    db.cliDevice.updateMany.mockImplementation(async (arg) => {
      const { where, data } = arg as {
        where: { connectionGeneration?: number };
        data: { status?: string };
      };
      if (where.connectionGeneration !== undefined && where.connectionGeneration !== row.generation)
        return { count: 0 };
      if (data.status) row.status = data.status;
      return { count: 1 };
    });
    const manager = new RelaySessionManager();
    const a = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket: a, identity: deviceIdentity("a"), now });
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    db.$transaction.mockImplementationOnce(async (callback: (tx: typeof db) => unknown) => {
      const committed = await callback(db);
      await gateA;
      return committed;
    });
    const helloA = manager.handleTextFrame(a, helloFrame(), now);
    await vi.waitFor(() => expect(row.generation).toBe(1));

    const b = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket: b, identity: deviceIdentity("b"), now });
    const heldB = holdNextRegistration();
    const helloB = manager.handleTextFrame(b, helloFrame(), now);
    await heldB.started;
    await manager.removeSession(b, now);
    heldB.release();
    await helloB;
    expect(row).toEqual({ generation: 2, status: "DISCONNECTED" });

    releaseA();
    await helloA;
    expect(a.closes).toEqual([{ code: 1000, reason: "replaced" }]);
    expect(manager.getActiveCliDeviceIds()).toEqual([]);
    expect(a.sends.some((frame) => String(frame).includes("hello.ok"))).toBe(false);
    manager.dispose();
  });

  it("refuses a heartbeat write whose session generation was superseded", async () => {
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket, identity, now });
    await manager.handleTextFrame(socket, helloFrame(), now);
    // The stored row moved to generation 2 (successor) or is no longer
    // CONNECTED: the fenced heartbeat matches nothing and cannot resurrect it.
    db.cliDevice.updateMany.mockImplementation(async (arg) => {
      const where = (arg as { where: { connectionGeneration?: number; status?: string } }).where;
      return { count: where.connectionGeneration === 2 && where.status === "CONNECTED" ? 1 : 0 };
    });
    await manager.handleTextFrame(
      socket,
      JSON.stringify({ type: "heartbeat", id: "hb" }),
      new Date(now.getTime() + 1_000),
    );
    expect(db.cliDevice.updateMany).toHaveBeenLastCalledWith({
      where: { id: "cli-device-id", connectionGeneration: 1, status: "CONNECTED" },
      data: { lastHeartbeatAt: new Date(now.getTime() + 1_000) },
    });
    // Still answers the CLI, so a fenced write never turns into a fatal error.
    expect(JSON.parse(String(socket.sends.at(-1))).type).toBe("heartbeat.pong");
    manager.dispose();
  });

  it("does not answer an inventory update whose socket was closed mid-write", async () => {
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket, identity: deviceIdentity("old"), now });
    await manager.handleTextFrame(socket, helloFrame(), now);
    const sendsAfterHello = socket.sends.length;
    const held = holdNextRegistration();
    const hello = JSON.parse(helloFrame()) as { endpoints: unknown[] };
    const update = manager.handleTextFrame(
      socket,
      JSON.stringify({ type: "inventory.update", id: "inv-1", endpoints: hello.endpoints }),
      now,
    );
    await held.started;

    await manager.closeSessionsForRevokedCredentials({ kind: "deviceCredential", ids: ["old"] });
    const sendsAfterClose = socket.sends.length;
    held.release();
    await update;

    expect(sendsAfterClose).toBe(sendsAfterHello + 1);
    expect(socket.sends).toHaveLength(sendsAfterClose);
    expect(manager.getActiveCliDeviceIds()).toEqual([]);
    manager.dispose();
  });

  it("closes every revoked socket even when a status write fails", async () => {
    const manager = new RelaySessionManager();
    const first = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket: first, identity: deviceIdentity("a"), now });
    await manager.handleTextFrame(first, helloFrame(), now);
    db.cliDevice.upsert.mockResolvedValueOnce({
      id: "cli-device-2",
      userId: "user-id",
      slug: "laptop",
    });
    credentials.cliDeviceCredential.findUnique.mockResolvedValueOnce({
      revokedAt: null,
      cliDeviceId: "cli-device-2",
    });
    const second = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket: second, identity: deviceIdentity("b"), now });
    await manager.handleTextFrame(second, helloFrame(), now);
    expect(manager.getActiveCliDeviceIds()).toHaveLength(2);
    // The device was deleted: its status write fails (or matches nothing).
    db.cliDevice.updateMany.mockRejectedValueOnce(new Error("gone"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await manager.closeSessionsForRevokedCredentials({
      kind: "deviceCredential",
      ids: ["a", "b"],
    });

    expect(first.closes).toEqual([{ code: 1008, reason: "access_denied" }]);
    expect(second.closes).toEqual([{ code: 1008, reason: "access_denied" }]);
    expect(manager.getActiveCliDeviceIds()).toEqual([]);
    errors.mockRestore();
    manager.dispose();
  });
});

describe("RelaySessionManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    seedRegistrationMocks();
  });

  it("matches the shared nonempty Rust inventory digest vector", () => {
    const parsed = parseRelayClientControlFrame(helloFrame());
    if (parsed.type !== "hello") throw new Error("expected hello frame");
    const parsedEndpoint = parsed.endpoints[0];
    if (!parsedEndpoint) throw new Error("expected endpoint");
    const endpoint: (typeof parsed.endpoints)[number] = {
      ...parsedEndpoint,
      slug: "example",
      label: "Example",
      defaultCapabilities: {
        version: 1,
        protocol: "openai-compatible",
        models: { list: true },
        chatCompletions: { supported: true, streaming: true },
      },
      models: [
        {
          slug: undefined,
          upstreamModelId: "model-a",
          capabilityOverrideMode: "inherit",
        },
      ],
    };
    expect(inventoryDigestFor([endpoint])).toBe(
      "52e5e23c121ae39dcc319aa506661ec50474c3c8c645cbe09a8121a47d37bc23",
    );
  });

  it("retries a write conflict so an identical snapshot keeps one revision", async () => {
    const parsed = parseRelayClientControlFrame(helloFrame());
    if (parsed.type !== "hello") throw new Error("expected hello frame");
    const conflict = Object.assign(new Error("serialization failure"), { code: "P2034" });
    db.$transaction.mockImplementationOnce(async () => {
      throw conflict;
    });

    const registration = await persistRelayRegistration({
      identity,
      cli: { slug: parsed.cli.slug },
      endpoints: parsed.endpoints,
      inventoryConfirmed: true,
      endpointTargeting: true,
      now,
    });

    expect(db.$transaction).toHaveBeenCalledTimes(2);
    // READ COMMITTED under the owner fence (@ws-model-proxy/db/capacity-lock-order).
    expect(db.$transaction).toHaveBeenLastCalledWith(expect.any(Function), {
      isolationLevel: "ReadCommitted",
    });
    expect(registration.revision).toEqual({
      inventorySeq: 1,
      inventoryDigest: "digest",
      inventoryAcknowledgedAt: now.toISOString(),
    });
  });

  it("registers a CLI session and persists endpoint/model capability metadata without endpoint secrets", async () => {
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket, identity, now });

    await manager.handleTextFrame(socket, helloFrame(), now);

    expect(manager.getActiveCliDeviceIds()).toEqual(["cli-device-id"]);
    expect(JSON.parse(String(socket.sends[0]))).toEqual({
      type: "hello.ok",
      id: "hello-id",
      protocolVersion: "2.8",
      revision: {
        inventorySeq: 1,
        inventoryDigest: "digest",
        inventoryAcknowledgedAt: now.toISOString(),
      },
      desiredCapabilities: [],
    });
    expect(db.endpoint.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.not.objectContaining({
          baseUrl: expect.anything(),
          authorization: expect.anything(),
        }),
      }),
    );
    expect(db.discoveredModel.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          slug: "llava-local",
          upstreamModelId: "llava/local",
          encodedModelId: "owner/desktop/local-openai/llava%2Flocal",
          capabilityOverrideMode: "OVERRIDE",
          capabilityOverrideMetadata: expect.objectContaining({
            protocol: "openai-compatible",
          }),
        }),
      }),
    );
    expect(db.poolMember.updateMany).toHaveBeenCalledWith({
      where: {
        OR: [
          {
            executionTargetId: { not: null },
            ExecutionTarget: { discoveredModelId: { in: ["model-id"] } },
          },
          { executionTargetId: null, discoveredModelId: { in: ["model-id"] } },
        ],
        routingStatus: { not: "DISABLED" },
      },
      data: {
        healthStatus: "HEALTHY",
        lastFailureClass: null,
        consecutiveRetryableFailures: 0,
        lastFailureAt: null,
        nextRetryAt: null,
        halfOpenTrialStartedAt: null,
      },
    });
  });

  it("relays a rebuilt multipart body with an exact declared size and final frame", async () => {
    vi.useRealTimers();
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket, identity, now });
    await manager.handleTextFrame(socket, helloFrame(), now);
    socket.sends.length = 0;

    const incoming = new FormData();
    incoming.append("prompt", "preserve me");
    incoming.append("model", "public/model");
    incoming.append(
      "file",
      new File([new Uint8Array([0, 255, 1, 2])], "folder/audio.wav", {
        type: "audio/wav",
      }),
    );
    const request = new Request("http://localhost/v1/audio/transcriptions", {
      method: "POST",
      body: incoming,
    });
    const contentType = request.headers.get("content-type");
    if (!contentType) throw new Error("expected multipart content type");
    const multipart = await parseMultipartToSpool(request, contentType);
    const built = multipart.build("upstream/model");
    const onRequestBodySent = vi.fn();
    try {
      manager.registerRelayResponseHandlers({
        cliDeviceId: "cli-device-id",
        requestId: "multipart-request",
        handlers: {
          onRequestBodySent,
          onHeaders: vi.fn(),
          onBody: vi.fn(),
          onComplete: vi.fn(),
          onError: vi.fn(),
          onCancelled: vi.fn(),
        },
      });
      manager.sendRelayRequest({
        cliDeviceId: "cli-device-id",
        endpointSlug: "local-openai",
        requestId: "multipart-request",
        family: "audio",
        method: "POST",
        path: "/v1/audio/transcriptions",
        headers: { "content-type": built.contentType },
        bodySource: built.body,
        timeoutMs: 30_000,
      });
      await vi.waitFor(() => {
        const frames = socket.sends.filter((frame) => typeof frame !== "string");
        expect(frames.length).toBeGreaterThan(0);
        expect(parseRelayBinaryFrame(frames.at(-1) as ArrayBuffer).metadata).toMatchObject({
          requestId: "multipart-request",
          final: true,
        });
      });
      const parsed = socket.sends
        .filter((frame) => typeof frame !== "string")
        .map((frame) => parseRelayBinaryFrame(frame as ArrayBuffer));
      const sentBytes = parsed.reduce((total, frame) => total + frame.body.byteLength, 0);
      expect(sentBytes).toBe(built.body.size);
      expect(onRequestBodySent.mock.calls.flat().reduce((total, value) => total + value, 0)).toBe(
        sentBytes,
      );
      const relayed = Buffer.concat(parsed.map((frame) => Buffer.from(frame.body))).toString(
        "latin1",
      );
      expect(relayed).toContain('name="model"\r\n\r\nupstream/model');
      expect(relayed.indexOf('name="prompt"')).toBeLessThan(relayed.indexOf('name="model"'));
      expect(relayed).toContain('filename="folder/audio.wav"');
    } finally {
      manager.completeRelayRequest("multipart-request");
      await multipart.dispose();
    }
  });

  it("updates heartbeat timestamps and sends pong frames", async () => {
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket, identity, now });
    await manager.handleTextFrame(socket, helloFrame(), now);

    const heartbeatAt = new Date("2026-01-01T00:00:20.000Z");
    await manager.handleTextFrame(
      socket,
      JSON.stringify({ type: "heartbeat", id: "heartbeat-id" }),
      heartbeatAt,
    );

    // Fenced by this session's connection generation and a still-CONNECTED row.
    expect(db.cliDevice.updateMany).toHaveBeenCalledWith({
      where: { id: "cli-device-id", connectionGeneration: 1, status: "CONNECTED" },
      data: { lastHeartbeatAt: heartbeatAt },
    });
    expect(JSON.parse(String(socket.sends.at(-1)))).toEqual({
      type: "heartbeat.pong",
      id: "heartbeat-id",
      receivedAt: heartbeatAt.toISOString(),
    });
  });

  it("marks sessions disconnected on socket close cleanup", async () => {
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket, identity, now });
    await manager.handleTextFrame(socket, helloFrame(), now);

    const closedAt = new Date("2026-01-01T00:01:00.000Z");
    await manager.removeSession(socket, closedAt);

    expect(db.cliDevice.updateMany).toHaveBeenCalledWith({
      where: { id: "cli-device-id", connectionGeneration: 1 },
      data: { status: "DISCONNECTED", lastDisconnectedAt: closedAt },
    });
    expect(db.poolMember.findMany).toHaveBeenLastCalledWith({
      where: {
        NOT: expect.objectContaining({ healthStatus: { in: ["UNHEALTHY", "DEGRADED"] } }),
        OR: [
          {
            executionTargetId: { not: null },
            ExecutionTarget: {
              DiscoveredModel: {
                Endpoint: { cliDeviceId: "cli-device-id", CliDevice: { connectionGeneration: 1 } },
              },
            },
          },
          {
            executionTargetId: null,
            DiscoveredModel: {
              Endpoint: { cliDeviceId: "cli-device-id", CliDevice: { connectionGeneration: 1 } },
            },
          },
        ],
      },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    expect(db.poolMember.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: "pool-member-id",
        NOT: expect.objectContaining({ healthStatus: { in: ["UNHEALTHY", "DEGRADED"] } }),
      },
      data: {
        healthStatus: "UNHEALTHY",
        lastFailureClass: "WEBSOCKET_DISCONNECTED",
        consecutiveRetryableFailures: 3,
        lastFailureAt: closedAt,
        nextRetryAt: new Date("2026-01-01T00:02:00.000Z"),
        halfOpenTrialStartedAt: null,
      },
    });
    expect(manager.getActiveCliDeviceIds()).toEqual([]);
  });

  it("makes disconnect-opened pool members due on a reconnect hello", async () => {
    const manager = new RelaySessionManager();
    const first = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket: first, identity, now });
    await manager.handleTextFrame(first, helloFrame(), now);
    await manager.removeSession(first, new Date(now.getTime() + 1_000));

    db.poolMember.updateMany.mockClear();
    const second = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket: second, identity, now });
    await manager.handleTextFrame(second, helloFrame(), now);

    const dueCall = db.poolMember.updateMany.mock.calls.find(
      ([arg]) => arg?.data && "nextRetryAt" in arg.data && arg.where.healthStatus === "UNHEALTHY",
    );
    expect(dueCall?.[0]).toMatchObject({
      where: {
        healthStatus: "UNHEALTHY",
        lastFailureClass: { in: ["WEBSOCKET_DISCONNECTED", "STALE_SESSION"] },
        nextRetryAt: { gt: expect.any(Date) },
      },
      data: { nextRetryAt: expect.any(Date) },
    });
    // Only the due time moves: a real failure state is never cleared here.
    expect(Object.keys(dueCall?.[0].data)).toEqual(["nextRetryAt"]);
    expect(JSON.parse(String(second.sends[0])).type).toBe("hello.ok");
  });

  it("refuses a stale disconnect write after a successor hello claimed the device", async () => {
    const manager = new RelaySessionManager();
    const stale = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket: stale, identity, now });
    await manager.handleTextFrame(stale, helloFrame(), now);

    // Simulate the stored device row having generation 2 by the time a
    // generation-1 (stale) write applies; an unfenced write matches (count 1),
    // which is what makes this test fail without the fence.
    db.cliDevice.updateMany.mockImplementation(async (arg) => ({
      count:
        (arg as { where: { connectionGeneration?: number } }).where.connectionGeneration ===
          undefined ||
        (arg as { where: { connectionGeneration?: number } }).where.connectionGeneration === 2
          ? 1
          : 0,
    }));

    // Gate the successor's registration transaction so the old close lands
    // while that registration is in flight — the widest window of the race (a
    // serializable transaction with up to three retries). At this point the
    // old session still owns sessionsByCliDeviceId, so detachSession's
    // ownership check passes and the disconnect chain is issued; a check
    // against that map would not catch the stale close.
    const held = holdNextRegistration();
    const successor = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket: successor, identity, now });
    const hello = manager.handleTextFrame(successor, helloFrame(), now);
    await held.started;

    // The old socket's close arrives mid-registration. detachSession sees the
    // (stale) session as the device's owner and issues the disconnect chain.
    const disconnectAt = new Date(now.getTime() + 5_000);
    await manager.removeSession(stale, disconnectAt);

    held.release();
    await hello;
    expect(manager.getActiveCliDeviceIds()).toEqual(["cli-device-id"]);
    expect(JSON.parse(String(successor.sends[0])).type).toBe("hello.ok");

    // The write is scoped to the generation the stale session held...
    expect(db.cliDevice.updateMany).toHaveBeenCalledWith({
      where: { id: "cli-device-id", connectionGeneration: 1 },
      data: { status: "DISCONNECTED", lastDisconnectedAt: disconnectAt },
    });
    // ...matched no row, and never ran the member write that would have
    // re-imposed the 60 s circuit-open over the hello's due-write.
    expect(db.poolMember.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ healthStatus: "UNHEALTHY" }),
      }),
    );
    manager.dispose();
  });

  it("keeps a disconnect only for a generation that has no successor", async () => {
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket, identity, now });
    await manager.handleTextFrame(socket, helloFrame(), now);
    db.poolMember.updateMany.mockClear();

    // No successor: the stored generation still equals the detached session's,
    // so the disconnect write applies (the fence must not swallow genuine
    // disconnects).
    const closedAt = new Date(now.getTime() + 1_000);
    await manager.removeSession(socket, closedAt);

    expect(db.cliDevice.updateMany).toHaveBeenCalledWith({
      where: { id: "cli-device-id", connectionGeneration: 1 },
      data: { status: "DISCONNECTED", lastDisconnectedAt: closedAt },
    });
    expect(db.poolMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              DiscoveredModel: expect.objectContaining({
                Endpoint: expect.objectContaining({
                  CliDevice: { connectionGeneration: 1 },
                }),
              }),
            }),
          ]),
        }),
      }),
    );
    expect(db.poolMember.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "pool-member-id" }) }),
    );
    manager.dispose();
  });

  it("writes nothing for a session that never claimed a generation (fail closed)", async () => {
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket, identity, now });
    db.cliDevice.upsert.mockResolvedValueOnce({
      id: "cli-device-id",
      userId: "user-id",
      slug: "desktop",
    });
    await manager.handleTextFrame(socket, helloFrame(), now);
    db.cliDevice.updateMany.mockClear();
    db.poolMember.updateMany.mockClear();

    // A registration that reported no generation must not degrade the write
    // into an unfenced one (`undefined` would drop the filter key in Prisma),
    // so it writes nothing and the normal heartbeat path restores presence.
    await manager.removeSession(socket, new Date(now.getTime() + 1_000));

    expect(db.cliDevice.updateMany).not.toHaveBeenCalled();
    expect(db.poolMember.updateMany).not.toHaveBeenCalled();
    expect(manager.getActiveCliDeviceIds()).toEqual([]);
    manager.dispose();
  });

  it("makes a disconnected device's members routable through a real reconnect hello", async () => {
    // AC #113 end to end over the manager + the routing decision (not wall
    // clock): disconnect -> the members cool for the full cooldown -> a
    // reconnect hello -> the member is due and reads as a routable HALF_OPEN
    // candidate for that device. Runs on the real clock because the hello's
    // due-write stamps `new Date()` (session-manager.ts:686), exactly as in
    // production.
    const { selectPoolRouteSequence } = await import("@ws-model-proxy/api/lib/model-pool-routing");
    const { PoolMemberRecoveryScheduler } = await import("./pool-member-recovery.js");
    const wake = vi.spyOn(PoolMemberRecoveryScheduler.prototype, "wake");
    const manager = new RelaySessionManager();
    const first = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket: first, identity, now });
    await manager.handleTextFrame(first, helloFrame(), now);

    const members = [
      {
        id: "member-1",
        poolId: "pool-1",
        discoveredModelId: "model-1",
        weight: 1,
        healthStatus: "HEALTHY" as "HEALTHY" | "UNHEALTHY",
        routingStatus: "ACTIVE" as const,
        lastFailureClass: null,
        consecutiveRetryableFailures: 0,
        lastFailureAt: null,
        nextRetryAt: null as Date | null,
        halfOpenTrialStartedAt: null,
        // A directly-configured member: selectPoolRouteSequence falls back to
        // DiscoveredModel when there is no execution target.
        ExecutionTarget: undefined,
        DiscoveredModel: {
          published: true,
          upstreamModelId: "llama",
          Endpoint: {
            id: "endpoint-1",
            slug: "local",
            published: true,
            cliDeviceId: "cli-device-id",
            status: "ONLINE",
            CliDevice: { status: "CONNECTED" as string },
          },
        },
      },
    ];
    db.poolMember.findMany.mockImplementation(async () => members);
    // The disconnect and the due-write transition the same in-memory rows the
    // way their SQL does.
    db.poolMember.updateMany.mockImplementation(
      async (arg: { data: { healthStatus?: string; nextRetryAt?: Date } }) => {
        if (arg.data.healthStatus === "UNHEALTHY") {
          members[0]!.healthStatus = "UNHEALTHY";
          members[0]!.nextRetryAt = arg.data.nextRetryAt ?? new Date();
          return { count: 1 };
        }
        if (arg.data.nextRetryAt !== undefined) {
          members[0]!.nextRetryAt = arg.data.nextRetryAt;
          return { count: 1 };
        }
        return { count: 0 };
      },
    );
    const select = () =>
      selectPoolRouteSequence({
        poolId: "pool-1",
        activeCliDeviceIds: manager.getActiveCliDeviceIds(),
        now: new Date(),
      });

    const startedAt = Date.now();
    await manager.removeSession(first, new Date());
    expect(members[0]!.healthStatus).toBe("UNHEALTHY");
    // Cooling: the disconnect opened the member for the full 60 s cooldown.
    expect(members[0]!.nextRetryAt!.getTime()).toBeGreaterThanOrEqual(startedAt + 60_000);
    expect((await select()).ok).toBe(false);

    const second = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket: second, identity, now });
    await manager.handleTextFrame(second, helloFrame(), now);

    // The hello's due-write pulled the cooldown to now; the same member is now
    // a routable HALF_OPEN candidate.
    expect(members[0]!.nextRetryAt!.getTime()).toBeLessThanOrEqual(Date.now());
    await expect(select()).resolves.toMatchObject({
      ok: true,
      candidates: [{ poolMemberId: "member-1", healthStatus: "HALF_OPEN" }],
    });
    // The recovery scheduler was woken so the probe runs without waiting for
    // the disconnect cooldown (issue #113's "probed at once").
    expect(wake).toHaveBeenCalled();
    wake.mockRestore();
    manager.dispose();
  });

  it("still accepts a hello when the reconnect health update fails", async () => {
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket, identity, now });
    db.poolMember.updateMany.mockImplementation(
      async (arg: { where: { healthStatus?: string } }) => {
        if (arg.where.healthStatus === "UNHEALTHY") throw new Error("db down");
        return { count: 0 };
      },
    );
    try {
      await manager.handleTextFrame(socket, helloFrame(), now);
    } finally {
      db.poolMember.updateMany.mockReset();
    }
    expect(JSON.parse(String(socket.sends[0])).type).toBe("hello.ok");
  });

  it("marks stale sessions and their pool members unavailable", async () => {
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket, identity, now });
    await manager.handleTextFrame(socket, helloFrame(), now);

    const staleAt = new Date(now.getTime() + RELAY_STALE_AFTER_MS + 1);
    await manager.checkStaleSessions(staleAt);

    expect(socket.closes).toEqual([{ code: 1001, reason: "stale" }]);
    expect(db.cliDevice.updateMany).toHaveBeenCalledWith({
      where: { id: "cli-device-id", connectionGeneration: 1 },
      data: { status: "STALE", lastDisconnectedAt: staleAt },
    });
    expect(db.poolMember.findMany).toHaveBeenLastCalledWith({
      where: {
        NOT: expect.objectContaining({ healthStatus: { in: ["UNHEALTHY", "DEGRADED"] } }),
        OR: [
          {
            executionTargetId: { not: null },
            ExecutionTarget: {
              DiscoveredModel: {
                Endpoint: { cliDeviceId: "cli-device-id", CliDevice: { connectionGeneration: 1 } },
              },
            },
          },
          {
            executionTargetId: null,
            DiscoveredModel: {
              Endpoint: { cliDeviceId: "cli-device-id", CliDevice: { connectionGeneration: 1 } },
            },
          },
        ],
      },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    expect(db.poolMember.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: "pool-member-id",
        NOT: expect.objectContaining({ healthStatus: { in: ["UNHEALTHY", "DEGRADED"] } }),
      },
      data: {
        healthStatus: "UNHEALTHY",
        lastFailureClass: "STALE_SESSION",
        consecutiveRetryableFailures: 3,
        lastFailureAt: staleAt,
        nextRetryAt: new Date(staleAt.getTime() + 60_000),
        halfOpenTrialStartedAt: null,
      },
    });
    expect(manager.getActiveCliDeviceIds()).toEqual([]);
  });

  it("rejects malformed protocol messages", async () => {
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket, identity, now });

    await manager.handleTextFrame(socket, "{not-json", now);

    expect(socket.closes).toEqual([{ code: 1002, reason: "protocol_error" }]);
  });

  it("logs schema rejection details and closes with a generic protocol error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket, identity, now });

    const frame = JSON.stringify({
      type: "hello",
      id: "hello-id",
      protocolVersion: "2.8",
      cli: {
        slug: "desktop",
        hostname: "desk-01.local",
        capabilities: capabilities26(),
      },
      endpoints: [
        {
          slug: "local-openai",
          label: "Local OpenAI",
          kind: "openai-compatible",
          status: "online",
          defaultCapabilities: {
            version: 5,
            protocol: "openai-compatible",
          },
          models: [],
        },
      ],
    });

    await manager.handleTextFrame(socket, frame, now);

    expect(consoleError).toHaveBeenCalledWith(
      "[relay] control frame schema rejected",
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringContaining("version"),
        }),
      ]),
    );
    expect(socket.closes).toEqual([{ code: 1002, reason: "protocol_error" }]);
    consoleError.mockRestore();
  });

  it("replaces older sockets for the same registered CLI device", async () => {
    const manager = new RelaySessionManager();
    const first = new FakeSocket();
    const second = new FakeSocket();

    manager.acceptAuthenticatedSocket({ socket: first, identity, now });
    await manager.handleTextFrame(first, helloFrame(), now);
    manager.acceptAuthenticatedSocket({ socket: second, identity, now });
    await manager.handleTextFrame(second, helloFrame(), now);

    expect(first.closes).toEqual([{ code: 1000, reason: "replaced" }]);
    expect(manager.getActiveCliDeviceIds()).toEqual(["cli-device-id"]);
  });

  it("streams request-body chunks within the flow-control window and resumes on credits", async () => {
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket, identity, now });
    await manager.handleTextFrame(socket, helloFrame(), now);
    socket.sends.length = 0;

    const extraChunks = 2;
    const chunkCount = RELAY_REQUEST_BODY_WINDOW_CHUNKS + extraChunks;
    const chunks = Array.from({ length: chunkCount }, (_, index) => new Uint8Array([index]));

    manager.sendRelayRequest({
      cliDeviceId: "cli-device-id",
      endpointSlug: "local-openai",
      requestId: "request-id",
      family: "chat.completions",
      method: "POST",
      path: "/v1/chat/completions",
      headers: { Authorization: "Bearer secret", Accept: "application/json" },
      bodyChunks: chunks,
      timeoutMs: 30_000,
    });

    // Control frame plus exactly one window of body frames; the remaining
    // chunks stay parked until the CLI returns credits.
    expect(socket.sends).toHaveLength(1 + RELAY_REQUEST_BODY_WINDOW_CHUNKS);
    const control = JSON.parse(String(socket.sends[0]));
    expect(control.type).toBe("relay.request");
    expect(control.expectBody).toBe(true);
    const firstChunk = parseRelayBinaryFrame(socket.sends[1] as ArrayBuffer);
    expect(firstChunk.metadata).toMatchObject({
      type: "relay.request.body",
      requestId: "request-id",
      chunkId: "0",
    });
    expect(
      firstChunk.metadata.type === "relay.request.body"
        ? (firstChunk.metadata.final ?? false)
        : true,
    ).toBe(false);

    // Granting credits flushes the remaining chunks and marks the last final.
    await manager.handleTextFrame(
      socket,
      JSON.stringify({
        type: "relay.request.body.ack",
        requestId: "request-id",
        credits: extraChunks,
      }),
      now,
    );
    expect(socket.sends).toHaveLength(1 + chunkCount);
    const lastChunk = parseRelayBinaryFrame(socket.sends.at(-1) as ArrayBuffer);
    expect(lastChunk.metadata).toMatchObject({
      type: "relay.request.body",
      requestId: "request-id",
      chunkId: `${chunkCount - 1}`,
      final: true,
    });
  });

  it("announces a lazy request body before its first chunk is available", async () => {
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket, identity, now });
    await manager.handleTextFrame(socket, helloFrame(), now);
    socket.sends.length = 0;
    let release: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });

    manager.sendRelayRequest({
      cliDeviceId: "cli-device-id",
      endpointSlug: "local-openai",
      requestId: "lazy-request-id",
      family: "audio",
      method: "POST",
      path: "/v1/audio/transcriptions",
      headers: { Accept: "text/event-stream" },
      bodySource: {
        size: 3,
        async *open() {
          await ready;
          yield new Uint8Array([1, 2, 3]);
        },
      },
      timeoutMs: 30_000,
    });

    expect(socket.sends).toHaveLength(1);
    expect(JSON.parse(String(socket.sends[0]))).toMatchObject({
      type: "relay.request",
      expectBody: true,
    });
    release?.();
    await vi.waitFor(() => expect(socket.sends).toHaveLength(2));
    const finalChunk = parseRelayBinaryFrame(socket.sends[1] as ArrayBuffer);
    expect(finalChunk.metadata.type === "relay.request.body" && finalChunk.metadata.final).toBe(
      true,
    );
  });

  it("rejects a lazy body that ends before its declared size", async () => {
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket, identity, now });
    await manager.handleTextFrame(socket, helloFrame(), now);
    const onError = vi.fn();
    manager.registerRelayResponseHandlers({
      cliDeviceId: "cli-device-id",
      requestId: "short-body",
      handlers: {
        onHeaders: vi.fn(),
        onBody: vi.fn(),
        onComplete: vi.fn(),
        onError,
        onCancelled: vi.fn(),
      },
    });

    manager.sendRelayRequest({
      cliDeviceId: "cli-device-id",
      endpointSlug: "local-openai",
      requestId: "short-body",
      family: "audio",
      method: "POST",
      path: "/v1/audio/transcriptions",
      headers: {},
      bodySource: {
        size: 4,
        async *open() {
          yield new Uint8Array([1, 2, 3]);
        },
      },
      timeoutMs: 30_000,
    });

    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ failure: "protocol_error", requestId: "short-body" }),
    );
  });

  it("closes a lazy body iterator when the request is cancelled", async () => {
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket, identity, now });
    await manager.handleTextFrame(socket, helloFrame(), now);
    const closed = vi.fn();

    manager.sendRelayRequest({
      cliDeviceId: "cli-device-id",
      endpointSlug: "local-openai",
      requestId: "cancelled-body",
      family: "audio",
      method: "POST",
      path: "/v1/audio/transcriptions",
      headers: {},
      bodySource: {
        size: 10,
        open() {
          const iterator: AsyncIterableIterator<Uint8Array> = {
            [Symbol.asyncIterator]() {
              return this;
            },
            next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
            return: async () => {
              closed();
              return { done: true, value: undefined };
            },
          };
          return iterator;
        },
      },
      timeoutMs: 30_000,
    });
    manager.cancelRelayRequest({
      cliDeviceId: "cli-device-id",
      requestId: "cancelled-body",
      reason: "cancelled",
    });

    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
  });

  it.each(["cancelled", "completed"] as const)(
    "does not send a delayed lazy-body chunk after the request is %s",
    async (terminal) => {
      const manager = new RelaySessionManager();
      const socket = new FakeSocket();
      manager.acceptAuthenticatedSocket({ socket, identity, now });
      await manager.handleTextFrame(socket, helloFrame(), now);
      socket.sends.length = 0;
      let resolveNext: ((result: IteratorResult<Uint8Array>) => void) | undefined;
      const closed = vi.fn();

      manager.sendRelayRequest({
        cliDeviceId: "cli-device-id",
        endpointSlug: "local-openai",
        requestId: `late-${terminal}`,
        family: "audio",
        method: "POST",
        path: "/v1/audio/transcriptions",
        headers: {},
        bodySource: {
          size: 3,
          open() {
            const iterator: AsyncIterableIterator<Uint8Array> = {
              [Symbol.asyncIterator]() {
                return this;
              },
              next: () =>
                new Promise<IteratorResult<Uint8Array>>((resolve) => {
                  resolveNext = resolve;
                }),
              return: async () => {
                closed();
                return { done: true, value: undefined };
              },
            };
            return iterator;
          },
        },
        timeoutMs: 30_000,
      });

      expect(socket.sends).toHaveLength(1);
      if (terminal === "cancelled") {
        manager.cancelRelayRequest({
          cliDeviceId: "cli-device-id",
          requestId: `late-${terminal}`,
          reason: "cancelled",
        });
      } else {
        manager.completeRelayRequest(`late-${terminal}`);
      }
      resolveNext?.({ done: false, value: new Uint8Array([1, 2, 3]) });

      await vi.waitFor(() => expect(closed).toHaveBeenCalled());
      // Cancellation adds one control frame; completion adds none. Neither may
      // add a binary body frame after the delayed read settles.
      const bodyFrames = socket.sends.filter((sent) => typeof sent !== "string");
      expect(bodyFrames).toEqual([]);
    },
  );

  it("clamps accumulated body credits to the window so over-acking cannot burst the whole body", async () => {
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket, identity, now });
    await manager.handleTextFrame(socket, helloFrame(), now);
    socket.sends.length = 0;

    // Three windows of body chunks so there is always more to burst than one
    // window ahead.
    const chunkCount = RELAY_REQUEST_BODY_WINDOW_CHUNKS * 3;
    const chunks = Array.from({ length: chunkCount }, (_, index) => new Uint8Array([index % 256]));

    manager.sendRelayRequest({
      cliDeviceId: "cli-device-id",
      endpointSlug: "local-openai",
      requestId: "request-id",
      family: "chat.completions",
      method: "POST",
      path: "/v1/chat/completions",
      headers: { Authorization: "Bearer secret", Accept: "application/json" },
      bodyChunks: chunks,
      timeoutMs: 30_000,
    });
    // Control frame plus exactly one window of body frames.
    expect(socket.sends).toHaveLength(1 + RELAY_REQUEST_BODY_WINDOW_CHUNKS);

    // A misbehaving CLI floods acks while the socket cannot drain them, trying to
    // accumulate an unbounded credit balance. Each grant is clamped to the window,
    // so the balance never accumulates past it.
    socket.readyState = 0; // not OPEN: pump is a no-op, credits would otherwise pile up
    for (let i = 0; i < 5; i += 1) {
      await manager.handleTextFrame(
        socket,
        JSON.stringify({
          type: "relay.request.body.ack",
          requestId: "request-id",
          credits: RELAY_REQUEST_BODY_WINDOW_CHUNKS,
        }),
        now,
      );
    }
    expect(socket.sends).toHaveLength(1 + RELAY_REQUEST_BODY_WINDOW_CHUNKS); // nothing sent while closed

    // Re-open and grant one more credit to trigger a pump. With the clamp the
    // balance is at most one window, so at most one further window bursts out —
    // never the whole remaining body.
    socket.readyState = WS_READY_STATE_OPEN;
    await manager.handleTextFrame(
      socket,
      JSON.stringify({
        type: "relay.request.body.ack",
        requestId: "request-id",
        credits: 1,
      }),
      now,
    );
    // Exactly one additional window bursts (not the remaining 2 windows).
    expect(socket.sends).toHaveLength(1 + RELAY_REQUEST_BODY_WINDOW_CHUNKS * 2);
    // Outstanding sent-unacked chunks never exceeded the window in any burst.
    const bodyFrames = socket.sends.slice(1).filter((send) => typeof send !== "string");
    expect(bodyFrames).toHaveLength(RELAY_REQUEST_BODY_WINDOW_CHUNKS * 2);
  });
});

function uncompressedKey(): string {
  const bytes = Buffer.alloc(65, 9);
  bytes[0] = 0x04;
  return bytes.toString("base64url");
}

function id16(fill = 3): string {
  return Buffer.alloc(16, fill).toString("base64url");
}

function helloCli(features?: {
  humanTerminal?: boolean;
  mcpCommandMode?: "off" | "supervised" | "unsupervised";
  terminalApproval?: boolean;
  terminalSupported?: boolean;
}) {
  return JSON.stringify({
    type: "hello",
    id: "hello-cli",
    protocolVersion: "2.8",
    cli: {
      slug: "desktop",
      hostname: "desk-01.local",
      version: "9.9.9",
      capabilities: capabilities26(features),
    },
    endpoints: [],
  });
}

describe("relay terminal and exec sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    seedRegistrationMocks();
    db.cliDevice.upsert.mockResolvedValue({
      id: "cli-device-id",
      userId: "user-id",
      slug: "desktop",
      allowHumanTerminal: true,
      mcpCommandMode: "UNSUPERVISED",
      connectionGeneration: 1,
    });
  });

  async function register(
    manager: InstanceType<typeof RelaySessionManager>,
    socket: FakeSocket,
    frame = helloCli(),
  ) {
    manager.acceptAuthenticatedSocket({ socket, identity, now });
    await manager.handleTextFrame(socket, frame, now);
    return socket;
  }

  it("persists allowFileToolsAsRoot from hello and reports the file features live", async () => {
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    const frame = JSON.parse(helloCli()) as {
      cli: { capabilities: { features: Record<string, unknown> } };
    };
    frame.cli.capabilities.features.allowFileToolsAsRoot = true;
    frame.cli.capabilities.features.mcpFileRead = true;
    frame.cli.capabilities.features.fileRootsConfigured = true;
    await register(manager, socket, JSON.stringify(frame));
    expect(db.cliDevice.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          reportedAllowFileToolsAsRoot: true,
          reportedMcpFileRead: true,
          reportedFileRoots: true,
        }),
      }),
    );
    expect(manager.getLiveCliFeatures(["cli-device-id"]).get("cli-device-id")).toMatchObject({
      protocolVersion: "2.8",
      fileOps: true,
      mcpFileRead: true,
      fileRootsConfigured: true,
      allowFileToolsAsRoot: true,
    });
  });

  it("reports fileOps live only when the 2.8 hello's own capability says so", async () => {
    // The live snapshot ANDs `protocolVersion >= 2.8` with the hello's own
    // `capabilities.fileOps`. A real 2.8 hello pins fileOps true (the strict
    // schema requires `z.literal(true)`), so the false side is reached by
    // clearing the recorded feature, exactly as a degraded/absent capability
    // would leave it.
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    await register(manager, socket);
    const snapshot = () => manager.getLiveCliFeatures(["cli-device-id"]).get("cli-device-id");
    expect(snapshot()).toMatchObject({ protocolVersion: "2.8", fileOps: true, mcpFileRead: false });

    const session = (
      Reflect.get(manager, "sessionsByCliDeviceId") as Map<
        string,
        { features: Record<string, unknown> | null }
      >
    ).get("cli-device-id");
    if (session) session.features = { ...session.features, fileOps: false, mcpFileRead: true };
    // The read switch reports true, yet the capability term withdraws fileOps.
    expect(snapshot()).toMatchObject({ protocolVersion: "2.8", fileOps: false, mcpFileRead: true });
  });

  it("drops file frames for an unknown op and refuses them before registration", async () => {
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    await register(manager, socket);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    socket.sends.length = 0;
    // A CLI that answers an op the server never sent, or sends a server-only frame.
    for (const frame of [
      { type: "file.rejected", opId: id16(9), reason: "conflict" },
      { type: "file.result", opId: id16(9), op: "mkdir", result: { created: true } },
      { type: "file.result", opId: id16(9), op: "mkdir", result: { leak: 1 } },
      {
        type: "file.op",
        mode: "unsupervised",
        readGrant: false,
        opId: id16(9),
        op: "read",
        args: { path: "~/a" },
      },
      { type: "file.cancel", opId: id16(9) },
    ]) {
      await manager.handleTextFrame(socket, JSON.stringify(frame), now);
    }
    manager.handleBinaryFrame(
      socket,
      encodeRelayBinaryFrame({ type: "file.data", opId: id16(9) }, new Uint8Array(4)),
    );
    manager.handleBinaryFrame(
      socket,
      encodeRelayBinaryFrame({ type: "file.body", opId: id16(9) }, new Uint8Array(4)),
    );
    expect(socket.closes).toEqual([]);
    expect(socket.sends).toEqual([]);

    const early = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket: early, identity, now });
    await manager.handleTextFrame(
      early,
      JSON.stringify({ type: "file.rejected", opId: id16(9), reason: "conflict" }),
      now,
    );
    expect(early.closes.length).toBeGreaterThan(0);
    errors.mockRestore();
  });

  it("echoes the client protocol version and persists reported columns only from hello", async () => {
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    await register(manager, socket, helloCli({ mcpCommandMode: "supervised" }));
    expect(JSON.parse(String(socket.sends[0])).protocolVersion).toBe("2.8");
    expect(db.cliDevice.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          cliVersion: "9.9.9",
          relayProtocolVersion: "2.8",
          reportedHumanTerminal: true,
          reportedMcpCommandMode: "SUPERVISED",
          reportedTerminalApproval: false,
          reportedTerminalSupported: true,
          reportedAllowFileToolsAsRoot: false,
          reportedHostname: "desk-01.local",
          featuresReportedAt: now,
        }),
      }),
    );
    expect(db.cliDevice.upsert.mock.calls[0]?.[0].update).not.toHaveProperty("name");
    expect(db.cliDevice.upsert.mock.calls[0]?.[0].create).not.toHaveProperty("name");
    expect(db.cliDevice.upsert.mock.calls[0]?.[0].update).not.toHaveProperty("allowHumanTerminal");
    expect(db.cliDevice.upsert.mock.calls[0]?.[0].update).not.toHaveProperty("mcpCommandMode");

    socket.sends.length = 0;
    db.cliDevice.upsert.mockClear();
    await manager.handleTextFrame(
      socket,
      JSON.stringify({
        type: "inventory.update",
        id: "inventory-id",
        endpoints: [],
      }),
      now,
    );
    expect(db.cliDevice.upsert.mock.calls[0]?.[0].update).not.toHaveProperty(
      "reportedHumanTerminal",
    );
    expect(db.cliDevice.upsert.mock.calls[0]?.[0].update).not.toHaveProperty(
      "reportedMcpCommandMode",
    );
    expect(db.cliDevice.upsert.mock.calls[0]?.[0].update).not.toHaveProperty("cliVersion");
    expect(db.cliDevice.upsert.mock.calls[0]?.[0].update).not.toHaveProperty("reportedHostname");
  });

  it("clears the reported hostname when a hello omits it", async () => {
    const manager = new RelaySessionManager();
    const frame = JSON.parse(helloCli()) as { cli: Record<string, unknown> };
    delete frame.cli.hostname;
    await register(manager, new FakeSocket(), JSON.stringify(frame));
    expect(db.cliDevice.upsert.mock.calls[0]?.[0].update).toMatchObject({
      reportedHostname: null,
    });
  });

  it.each([
    [
      "a 2.6 hello (a released 0.4.x CLI)",
      (() => {
        const frame = JSON.parse(helloCli()) as {
          protocolVersion: string;
          cli: { capabilities: Record<string, unknown> & { features: Record<string, unknown> } };
        };
        frame.protocolVersion = "2.6";
        frame.cli.capabilities.protocolVersion = "2.6";
        delete frame.cli.capabilities.nodeTelemetry;
        delete frame.cli.capabilities.features.remoteMetricSources;
        return JSON.stringify(frame);
      })(),
    ],
    [
      "a 2.5 hello",
      (() => {
        const frame = JSON.parse(helloCli()) as {
          protocolVersion: string;
          cli: { capabilities: Record<string, unknown> };
        };
        frame.protocolVersion = "2.5";
        frame.cli.capabilities.protocolVersion = "2.5";
        delete frame.cli.capabilities.supervisedCommands;
        return JSON.stringify(frame);
      })(),
    ],
    [
      "a 0.3.x hello (2.3 with cli.label, no hostname)",
      JSON.stringify({
        type: "hello",
        id: "old",
        protocolVersion: "2.3",
        cli: {
          slug: "desktop",
          label: "Desktop",
          version: "0.3.1",
          capabilities: {
            protocolVersion: "2.3",
            inventoryAck: true,
            inventoryReplace: true,
            endpointTargeting: true,
            binaryFrames: true,
            cancellation: true,
            maxBinaryChunkBytes: 1024 * 1024,
            requestBodyStreaming: true,
            requestBodyWindowChunks: RELAY_REQUEST_BODY_WINDOW_CHUNKS,
            sharedTokenizerTps: true,
            standardizedMetrics: true,
          },
        },
        endpoints: [],
      }),
    ],
    [
      "a 2.6 hello carrying cli.label",
      (() => {
        const frame = JSON.parse(helloCli()) as { cli: Record<string, unknown> };
        frame.cli.label = "Desktop";
        return JSON.stringify(frame);
      })(),
    ],
    [
      "a 2.9 hello (a CLI newer than this server)",
      (() => {
        const frame = JSON.parse(helloCli()) as {
          protocolVersion: string;
          cli: { capabilities: Record<string, unknown> };
        };
        frame.protocolVersion = "2.9";
        frame.cli.capabilities.protocolVersion = "2.9";
        return JSON.stringify(frame);
      })(),
    ],
    [
      // The top-level version alone must trip the gate: the capability echo is
      // still 2.8, so the capability comparison would not refuse this frame.
      "a 2.9 hello whose capability echo still says 2.8",
      (() => {
        const frame = JSON.parse(helloCli()) as { protocolVersion: string };
        frame.protocolVersion = "2.9";
        return JSON.stringify(frame);
      })(),
    ],
  ])("refuses %s with the upgrade message before schema parsing", async (_, frame) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    await register(manager, socket, frame);
    expect(socket.sends.map((send) => JSON.parse(String(send)))).toEqual([
      {
        type: "protocol.error",
        failure: "protocol_error",
        message: RELAY_UPGRADE_REQUIRED_MESSAGE,
      },
    ]);
    expect(socket.closes).toEqual([{ code: 1002, reason: "protocol_error" }]);
    expect(db.cliDevice.upsert).not.toHaveBeenCalled();
    expect(manager.getActiveCliDeviceIds()).toEqual([]);
    // Refused before the strict schema, so no schema-rejection log.
    expect(consoleError).not.toHaveBeenCalledWith(
      "[relay] control frame schema rejected",
      expect.anything(),
    );
    consoleError.mockRestore();
  });

  it("records a refused hello's versions on the device a bound credential names", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    const frame = JSON.parse(helloCli()) as {
      protocolVersion: string;
      cli: { version?: string; capabilities: Record<string, unknown> };
    };
    frame.protocolVersion = "2.6";
    frame.cli.version = "0.4.0";
    frame.cli.capabilities.protocolVersion = "2.6";
    manager.acceptAuthenticatedSocket({
      socket,
      identity: { ...identity, kind: "deviceCredential", cliDeviceId: "bound-device" },
      now,
    });
    await manager.handleTextFrame(socket, JSON.stringify(frame), now);
    expect(socket.closes).toEqual([{ code: 1002, reason: "protocol_error" }]);
    expect(db.cliDevice.updateMany).toHaveBeenCalledWith({
      where: { id: "bound-device", userId: "user-id" },
      data: {
        rejectedRelayProtocolVersion: "2.6",
        rejectedCliVersion: "0.4.0",
        relayRejectedAt: now,
      },
    });
    expect(consoleError).toHaveBeenCalledWith(
      "[relay] refused a hello older than the minimum relay protocol",
      { protocolVersion: "2.6", cliVersion: "0.4.0" },
    );

    // An unbound token names no device: nothing is written.
    db.cliDevice.updateMany.mockClear();
    const unbound = new FakeSocket();
    await register(manager, unbound, JSON.stringify(frame));
    expect(unbound.closes).toEqual([{ code: 1002, reason: "protocol_error" }]);
    expect(db.cliDevice.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ rejectedRelayProtocolVersion: "2.6" }),
      }),
    );
    consoleError.mockRestore();
  });

  it("stores only sanitised versions from a refused hello with hostile client strings", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    const frame = JSON.parse(helloCli()) as {
      protocolVersion: string;
      cli: { version?: string; capabilities: Record<string, unknown> };
    };
    frame.protocolVersion = `2.${"9".repeat(40)}`;
    frame.cli.version = "1.0.0\u001b[31m\n";
    manager.acceptAuthenticatedSocket({
      socket,
      identity: { ...identity, kind: "deviceCredential", cliDeviceId: "bound-device" },
      now,
    });
    await manager.handleTextFrame(socket, JSON.stringify(frame), now);
    expect(db.cliDevice.updateMany).toHaveBeenCalledWith({
      where: { id: "bound-device", userId: "user-id" },
      data: { rejectedRelayProtocolVersion: null, rejectedCliVersion: null, relayRejectedAt: now },
    });
    expect(consoleError).toHaveBeenCalledWith(
      "[relay] refused a hello older than the minimum relay protocol",
      { protocolVersion: null, cliVersion: null },
    );
    consoleError.mockRestore();
  });

  it("records a refused newer hello as the claimed protocol version", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    const frame = JSON.parse(helloCli()) as {
      protocolVersion: string;
      cli: { version?: string; capabilities: Record<string, unknown> };
    };
    frame.protocolVersion = "2.9";
    frame.cli.version = "0.9.0-rc.1+build.5";
    frame.cli.capabilities.protocolVersion = "2.9";
    manager.acceptAuthenticatedSocket({
      socket,
      identity: { ...identity, kind: "deviceCredential", cliDeviceId: "bound-device" },
      now,
    });
    await manager.handleTextFrame(socket, JSON.stringify(frame), now);
    expect(socket.sends.map((send) => JSON.parse(String(send)))).toEqual([
      {
        type: "protocol.error",
        failure: "protocol_error",
        message: RELAY_UPGRADE_REQUIRED_MESSAGE,
      },
    ]);
    expect(socket.closes).toEqual([{ code: 1002, reason: "protocol_error" }]);
    expect(db.cliDevice.updateMany).toHaveBeenCalledWith({
      where: { id: "bound-device", userId: "user-id" },
      data: {
        rejectedRelayProtocolVersion: "2.9",
        rejectedCliVersion: "0.9.0-rc.1+build.5",
        relayRejectedAt: now,
      },
    });
    // Nothing was registered, so no device became routable.
    expect(db.cliDevice.upsert).not.toHaveBeenCalled();
    expect(manager.getActiveCliDeviceIds()).toEqual([]);
    consoleError.mockRestore();
  });

  it("registers a valid 2.8 hello", async () => {
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    await register(manager, socket);
    expect(JSON.parse(String(socket.sends[0]))).toMatchObject({ type: "hello.ok" });
    expect(manager.getActiveCliDeviceIds()).toEqual(["cli-device-id"]);
  });

  it("tears down terminals and commands on close, replacement, and grant removal", async () => {
    const events: string[] = [];
    const { registerTerminalBridge } = await import("./session-manager.js");
    registerTerminalBridge({
      onTerminalEvent(event) {
        events.push(event.type);
      },
    });
    const manager = new RelaySessionManager();
    const first = new FakeSocket();
    await register(manager, first);
    const terminalId = id16(6);
    expect(
      manager.startTerminal({
        terminalId,
        userId: "user-id",
        cliDeviceId: "cli-device-id",
        cols: 80,
        rows: 24,
        browserPublicKey: uncompressedKey(),
        browserNonce: id16(4),
        connId: "viewer",
      }),
    ).toBe(true);
    let cancelled = false;
    const command = {
      commandId: id16(8),
      cliDeviceId: "cli-device-id",
      status: "running" as "running" | "cancelled",
      markCancelled() {
        cancelled = true;
        command.status = "cancelled";
      },
      markStarted() {},
      markRejected() {},
      markDone() {},
      appendOutput() {},
    };
    expect(manager.dispatchExecStart(command, { command: "pwd" })).toBe(true);
    const onError = vi.fn();
    manager.registerRelayResponseHandlers({
      cliDeviceId: "cli-device-id",
      requestId: "request-id",
      handlers: {
        onHeaders() {},
        onBody() {},
        onComplete() {},
        onError,
        onCancelled() {},
      },
    });

    manager.applyFeatureGrants("cli-device-id", {
      mcpFileRead: false,
      allowHumanTerminal: false,
      mcpCommandMode: "off",
    });
    const control = first.sends
      .filter((send) => typeof send === "string")
      .map((send) => JSON.parse(String(send)));
    expect(
      control.some((message) => message.type === "term.close" && message.terminalId === terminalId),
    ).toBe(true);
    expect(control.some((message) => message.type === "exec.cancel")).toBe(true);
    expect(cancelled).toBe(true);
    expect(command.status).toBe("cancelled");
    expect(events).toContain("exit");
    expect(manager.listTerminalsForUser("user-id")).toEqual([]);

    db.cliDevice.upsert.mockResolvedValue({
      id: "cli-device-id",
      userId: "user-id",
      slug: "desktop",
      allowHumanTerminal: true,
      mcpCommandMode: "UNSUPERVISED",
      connectionGeneration: 1,
    });
    const again = new FakeSocket();
    await register(manager, again);
    const secondTerminal = id16(9);
    manager.startTerminal({
      terminalId: secondTerminal,
      userId: "user-id",
      cliDeviceId: "cli-device-id",
      cols: 80,
      rows: 24,
      browserPublicKey: uncompressedKey(),
      browserNonce: id16(4),
      connId: "viewer-2",
    });
    const replacement = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket: replacement, identity, now });
    await manager.handleTextFrame(replacement, helloCli(), now);
    expect(again.closes).toEqual([{ code: 1000, reason: "replaced" }]);
    expect(
      again.sends
        .filter((send) => typeof send === "string")
        .some((send) => JSON.parse(String(send)).type === "term.close"),
    ).toBe(true);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ failure: "disconnected" }));
    expect(db.cliDevice.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "DISCONNECTED" }) }),
    );

    const survivor = new FakeSocket();
    await register(manager, survivor);
    manager.startTerminal({
      terminalId: id16(10),
      userId: "user-id",
      cliDeviceId: "cli-device-id",
      cols: 40,
      rows: 12,
      browserPublicKey: uncompressedKey(),
      browserNonce: id16(4),
      connId: "viewer-3",
    });
    await manager.removeSession(survivor, now);
    expect(db.cliDevice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "cli-device-id", connectionGeneration: 1 }),
        data: expect.objectContaining({ status: "DISCONNECTED" }),
      }),
    );
    expect(
      survivor.sends.some(
        (send) => typeof send === "string" && JSON.parse(String(send)).type === "term.close",
      ),
    ).toBe(true);
  });

  it("closes only the malformed terminal and keeps the relay socket up", async () => {
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    await register(manager, socket);
    const terminalId = id16(11);
    manager.startTerminal({
      terminalId,
      userId: "user-id",
      cliDeviceId: "cli-device-id",
      cols: 80,
      rows: 24,
      browserPublicKey: uncompressedKey(),
      browserNonce: id16(4),
      connId: "viewer",
    });
    await manager.handleTextFrame(
      socket,
      JSON.stringify({ type: "term.exit", terminalId, exitCode: "nope" }),
      now,
    );
    expect(socket.closes).toEqual([]);
    expect(manager.listTerminalsForUser("user-id")).toEqual([]);
    expect(manager.getActiveCliDeviceIds()).toEqual(["cli-device-id"]);
  });

  it("does not throw out of handleBinaryFrame on a binary parse error", async () => {
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    await register(manager, socket);
    expect(() => manager.handleBinaryFrame(socket, new ArrayBuffer(1))).not.toThrow();
    expect(socket.closes).toEqual([]);
    expect(manager.getActiveCliDeviceIds()).toEqual(["cli-device-id"]);
  });
});

describe("relay terminal viewers", () => {
  type Event = import("./session-manager.js").TerminalLifecycleEvent;
  let events: Event[] = [];

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    seedRegistrationMocks();
    db.cliDevice.upsert.mockResolvedValue({
      id: "cli-device-id",
      userId: "user-id",
      slug: "desktop",
      allowHumanTerminal: true,
      mcpCommandMode: "UNSUPERVISED",
      connectionGeneration: 1,
    });
    events = [];
    const { registerTerminalBridge } = await import("./session-manager.js");
    registerTerminalBridge({
      onTerminalEvent(event) {
        events.push(event);
      },
    });
  });

  function control(socket: FakeSocket) {
    return socket.sends
      .filter((send): send is string => typeof send === "string")
      .map((send) => JSON.parse(send) as Record<string, unknown>);
  }

  function eventsFor(connId: string) {
    return events.filter(
      (event) =>
        ("connId" in event && event.connId === connId) ||
        ("connIds" in event && event.connIds.includes(connId)) ||
        ("recipients" in event && event.recipients.some((entry) => entry.connId === connId)),
    );
  }

  async function setup(frame = helloCli()) {
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket, identity, now });
    await manager.handleTextFrame(socket, frame, now);
    return { manager, socket };
  }

  /** Opens a terminal from conn "a" and completes term.opened. Returns the opener's viewer id. */
  async function openTerminal(
    manager: InstanceType<typeof RelaySessionManager>,
    socket: FakeSocket,
    terminalId = id16(20),
  ) {
    expect(
      manager.startTerminal({
        terminalId,
        userId: "user-id",
        cliDeviceId: "cli-device-id",
        cols: 80,
        rows: 24,
        browserPublicKey: uncompressedKey(),
        browserNonce: id16(4),
        connId: "a",
      }),
    ).toBe(true);
    const open = control(socket).find((message) => message.type === "term.open");
    const viewerId = open?.viewerId as string;
    expect(viewerId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    await manager.handleTextFrame(
      socket,
      JSON.stringify({ type: "term.opened", terminalId, viewerId, cliNonce: id16(5) }),
      now,
    );
    return viewerId;
  }

  function attach(
    manager: InstanceType<typeof RelaySessionManager>,
    connId: string,
    terminalId = id16(20),
  ) {
    return manager.attachTerminal({
      terminalId,
      userId: "user-id",
      connId,
      browserPublicKey: uncompressedKey(),
      browserNonce: id16(4),
    });
  }

  it("keeps MCP commands and terminal keys for a 2.8 CLI and persists the version", async () => {
    const { manager } = await setup();
    expect(db.cliDevice.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          relayProtocolVersion: "2.8",
          reportedMcpCommandMode: "UNSUPERVISED",
          reportedHumanTerminal: true,
        }),
      }),
    );
    expect(manager.getLiveCliFeatures(["cli-device-id"]).get("cli-device-id")).toMatchObject({
      protocolVersion: "2.8",
      mcpCommandMode: "unsupervised",
      supervisedCommands: true,
      terminalPublicKey: uncompressedKey(),
    });
    const command = {
      commandId: id16(5),
      cliDeviceId: "cli-device-id",
      status: "running" as const,
      markCancelled() {},
      markStarted() {},
      markRejected() {},
      markDone() {},
      appendOutput() {},
    };
    expect(manager.dispatchExecStart(command, { command: "pwd" })).toBe(true);
  });

  it("keeps a CLI identity proof for the terminal list", async () => {
    const identityKey = Buffer.alloc(65, 3);
    identityKey[0] = 0x04;
    const terminalIdentity = {
      publicKey: identityKey.toString("base64url"),
      signature: Buffer.alloc(64, 7).toString("base64url"),
    };
    const frame = JSON.parse(helloCli()) as { cli: { capabilities: Record<string, unknown> } };
    frame.cli.capabilities.terminalIdentity = terminalIdentity;
    const { manager } = await setup(JSON.stringify(frame));
    expect(manager.getLiveCliFeatures(["cli-device-id"]).get("cli-device-id")).toMatchObject({
      terminalPublicKey: uncompressedKey(),
      terminalIdentity,
    });
  });

  it("reports no identity for a CLI that sent none", async () => {
    const { manager } = await setup();
    expect(
      manager.getLiveCliFeatures(["cli-device-id"]).get("cli-device-id")?.terminalIdentity,
    ).toBeNull();
  });

  it("lets two viewers coexist without a detached event", async () => {
    const { manager, socket } = await setup();
    const terminalId = id16(20);
    const opener = await openTerminal(manager, socket, terminalId);
    expect(eventsFor("a")).toEqual([
      expect.objectContaining({ type: "opened", connId: "a", viewerId: opener }),
      expect.objectContaining({
        type: "viewers",
        count: 1,
        recipients: [{ connId: "a", writer: "you" }],
      }),
    ]);

    const attached = attach(manager, "b", terminalId);
    expect(attached.ok).toBe(true);
    const second = attached.ok ? attached.viewerId : "";
    expect(second).not.toBe(opener);
    expect(control(socket).at(-1)).toMatchObject({
      type: "term.attach",
      terminalId,
      viewerId: second,
    });
    await manager.handleTextFrame(
      socket,
      JSON.stringify({ type: "term.attached", terminalId, viewerId: second, cliNonce: id16(6) }),
      now,
    );
    expect(events.some((event) => event.type === "detached")).toBe(false);
    expect(events.at(-2)).toMatchObject({ type: "attached", connId: "b", viewerId: second });
    expect(events.at(-1)).toMatchObject({
      type: "viewers",
      count: 2,
      recipients: [
        { connId: "a", writer: "you" },
        { connId: "b", writer: "other" },
      ],
    });
    expect(manager.listTerminalsForUser("user-id", "b")).toEqual([
      expect.objectContaining({
        viewerAttached: true,
        viewerCount: 2,
        attachedHere: true,
        writerHere: false,
      }),
    ]);
    expect(manager.listTerminalsForUser("user-id", "a")[0]).toMatchObject({ writerHere: true });
    expect(manager.listTerminalsForUser("user-id", "z")[0]).toMatchObject({
      attachedHere: false,
      writerHere: false,
    });
  });

  it("routes unicast to one viewer, broadcast to all, and drops unknown viewers", async () => {
    const { manager, socket } = await setup();
    const terminalId = id16(20);
    const opener = await openTerminal(manager, socket, terminalId);
    const attached = attach(manager, "b", terminalId);
    const second = attached.ok ? attached.viewerId : "";
    await manager.handleTextFrame(
      socket,
      JSON.stringify({ type: "term.attached", terminalId, viewerId: second, cliNonce: id16(6) }),
      now,
    );
    events = [];
    const body = new Uint8Array([1, 2, 3]);
    manager.handleBinaryFrame(
      socket,
      encodeRelayBinaryFrame({ type: "term.sealed", terminalId, seq: 1, viewerId: second }, body),
    );
    manager.handleBinaryFrame(
      socket,
      encodeRelayBinaryFrame({ type: "term.sealed", terminalId, seq: 1, epoch: 3 }, body),
    );
    manager.handleBinaryFrame(
      socket,
      encodeRelayBinaryFrame({ type: "term.sealed", terminalId, seq: 2, viewerId: id16(30) }, body),
    );
    manager.handleBinaryFrame(
      socket,
      encodeRelayBinaryFrame({ type: "term.sealed", terminalId, seq: 3 }, body),
    );
    expect(events).toEqual([
      expect.objectContaining({ type: "sealed", connIds: ["b"], seq: 1 }),
      expect.objectContaining({ type: "sealed", connIds: ["a", "b"], seq: 1, epoch: 3 }),
    ]);
    expect(events[0]).not.toHaveProperty("epoch");
    expect(manager.listTerminalsForUser("user-id")).toHaveLength(1);
    expect(opener).not.toBe(second);
  });

  it("stamps the sending viewer's id on browser input and refuses a pending tab", async () => {
    const { manager, socket } = await setup(helloCli({ terminalApproval: true }));
    const terminalId = id16(20);
    const opener = await openTerminal(manager, socket, terminalId);
    const body = new Uint8Array([7]);
    expect(manager.forwardBrowserSealed(terminalId, "user-id", "a", 1, body)).toBe("sent");
    const frame = socket.sends.at(-1);
    expect(frame).toBeInstanceOf(ArrayBuffer);
    expect(parseRelayBinaryFrame(frame as ArrayBuffer).metadata).toEqual({
      type: "term.sealed",
      terminalId,
      seq: 1,
      viewerId: opener,
    });
    expect(attach(manager, "b", terminalId).ok).toBe(true);
    expect(manager.forwardBrowserSealed(terminalId, "user-id", "b", 1, body)).toBe("missing");
    expect(manager.forwardBrowserSealed(terminalId, "other-user", "a", 2, body)).toBe("missing");
  });

  it("approves pending viewers independently and tells only the requester", async () => {
    const { manager, socket } = await setup(helloCli({ terminalApproval: true }));
    const terminalId = id16(20);
    await openTerminal(manager, socket, terminalId);
    const b = attach(manager, "b", terminalId);
    const c = attach(manager, "c", terminalId);
    const bId = b.ok ? b.viewerId : "";
    const cId = c.ok ? c.viewerId : "";
    for (const viewerId of [bId, cId]) {
      await manager.handleTextFrame(
        socket,
        JSON.stringify({ type: "term.pending", terminalId, viewerId, cliNonce: id16(6) }),
        now,
      );
    }
    expect(eventsFor("b").filter((event) => event.type === "pending")).toHaveLength(1);
    expect(eventsFor("c").filter((event) => event.type === "pending")).toHaveLength(1);

    expect(manager.forwardTerminalAuth(terminalId, "user-id", "c", "c2lnbmF0dXJl")).toBe("sent");
    expect(control(socket).at(-1)).toEqual({
      type: "term.auth",
      terminalId,
      viewerId: cId,
      signature: "c2lnbmF0dXJl",
    });
    expect(manager.forwardTerminalAuth(terminalId, "user-id", "z", "c2lnbmF0dXJl")).toBe(
      "not_found",
    );
    await manager.handleTextFrame(
      socket,
      JSON.stringify({ type: "term.attached", terminalId, viewerId: cId, cliNonce: id16(7) }),
      now,
    );
    await manager.handleTextFrame(
      socket,
      JSON.stringify({ type: "term.rejected", terminalId, viewerId: bId, reason: "denied" }),
      now,
    );
    expect(eventsFor("c").some((event) => event.type === "attached")).toBe(true);
    expect(eventsFor("b").filter((event) => event.type === "rejected")).toEqual([
      expect.objectContaining({ connId: "b", reason: "denied" }),
    ]);
    expect(eventsFor("a").some((event) => event.type === "rejected")).toBe(false);
    expect(manager.listTerminalsForUser("user-id")[0]).toMatchObject({ viewerCount: 2 });
  });

  it("detaches one viewer, reports writer changes, and clears the writer when it leaves", async () => {
    const { manager, socket } = await setup();
    const terminalId = id16(20);
    const opener = await openTerminal(manager, socket, terminalId);
    const b = attach(manager, "b", terminalId);
    const bId = b.ok ? b.viewerId : "";
    await manager.handleTextFrame(
      socket,
      JSON.stringify({ type: "term.attached", terminalId, viewerId: bId, cliNonce: id16(6) }),
      now,
    );
    events = [];
    await manager.handleTextFrame(
      socket,
      JSON.stringify({ type: "term.writer", terminalId, viewerId: bId }),
      now,
    );
    expect(events).toEqual([
      {
        type: "viewers",
        terminalId,
        count: 2,
        recipients: [
          { connId: "a", writer: "other" },
          { connId: "b", writer: "you" },
        ],
      },
    ]);
    // The same writer again is not news.
    await manager.handleTextFrame(
      socket,
      JSON.stringify({ type: "term.writer", terminalId, viewerId: bId }),
      now,
    );
    expect(events).toHaveLength(1);

    expect(manager.detachTerminalViewer(terminalId, "user-id", "b")).toBe(true);
    expect(control(socket).at(-1)).toEqual({ type: "term.detach", terminalId, viewerId: bId });
    expect(events.at(-1)).toEqual({
      type: "viewers",
      terminalId,
      count: 1,
      recipients: [{ connId: "a", writer: "none" }],
    });
    expect(manager.detachTerminalViewer(terminalId, "user-id", "b")).toBe(false);
    expect(control(socket).some((message) => message.type === "term.close")).toBe(false);

    await manager.handleTextFrame(
      socket,
      JSON.stringify({ type: "term.writer", terminalId, viewerId: opener }),
      now,
    );
    expect(events.at(-1)).toMatchObject({ recipients: [{ connId: "a", writer: "you" }] });
    await manager.handleTextFrame(socket, JSON.stringify({ type: "term.writer", terminalId }), now);
    expect(events.at(-1)).toMatchObject({ recipients: [{ connId: "a", writer: "none" }] });
  });

  it("caps viewers plus pending approvals at eight per terminal", async () => {
    const { manager, socket } = await setup(helloCli({ terminalApproval: true }));
    const terminalId = id16(20);
    await openTerminal(manager, socket, terminalId);
    for (let index = 1; index < 8; index += 1) {
      expect(attach(manager, `tab-${index}`, terminalId).ok).toBe(true);
    }
    expect(attach(manager, "tab-8", terminalId)).toEqual({ ok: false, error: "limit" });
    // A tab that attaches again replaces its own slot instead of taking another.
    expect(attach(manager, "tab-1", terminalId).ok).toBe(true);
    expect(manager.detachTerminalViewer(terminalId, "user-id", "tab-2")).toBe(true);
    expect(attach(manager, "tab-8", terminalId).ok).toBe(true);
    // Attaching never counts toward the per-user and per-CLI terminal limits.
    expect(manager.terminalCounts("user-id", "cli-device-id")).toEqual({ user: 1, cli: 1 });
  });

  it("expires pending viewers and cleans up every attachment when a tab goes away", async () => {
    const { manager, socket } = await setup(helloCli({ terminalApproval: true }));
    const terminalId = id16(20);
    await openTerminal(manager, socket, terminalId);
    const b = attach(manager, "b", terminalId);
    const bId = b.ok ? b.viewerId : "";
    manager.sweepExpiredPendingTerminals(Date.now() + 2 * 60 * 1000 + 1);
    expect(eventsFor("b").at(-1)).toMatchObject({ type: "rejected", reason: "expired" });
    expect(control(socket).at(-1)).toEqual({ type: "term.detach", terminalId, viewerId: bId });
    expect(manager.forwardTerminalAuth(terminalId, "user-id", "b", "c2ln")).toBe("not_found");

    const c = attach(manager, "c", terminalId);
    const cId = c.ok ? c.viewerId : "";
    manager.releaseBrowserViewer("user-id", "c");
    expect(control(socket).at(-1)).toEqual({ type: "term.detach", terminalId, viewerId: cId });
    expect(manager.listTerminalsForUser("user-id", "c")[0]).toMatchObject({ attachedHere: false });
    // A late CLI answer for a viewer that left is dropped.
    events = [];
    await manager.handleTextFrame(
      socket,
      JSON.stringify({ type: "term.attached", terminalId, viewerId: cId, cliNonce: id16(6) }),
      now,
    );
    expect(events).toEqual([]);
  });

  it.each([["current", helloCli({ terminalApproval: true })]])(
    "closes an expired approval handshake on the %s CLI and a late term.opened",
    async (_, frame) => {
      const { manager, socket } = await setup(frame);
      const terminalId = id16(20);
      expect(
        manager.startTerminal({
          terminalId,
          userId: "user-id",
          cliDeviceId: "cli-device-id",
          cols: 80,
          rows: 24,
          browserPublicKey: uncompressedKey(),
          browserNonce: id16(4),
          connId: "a",
        }),
      ).toBe(true);
      const open = control(socket).find((message) => message.type === "term.open");
      const viewerId = open?.viewerId as string;
      manager.sweepExpiredPendingTerminals(Date.now() + 2 * 60 * 1000 + 1);
      expect(eventsFor("a").at(-1)).toMatchObject({ type: "rejected", reason: "expired" });
      expect(control(socket).at(-1)).toEqual({ type: "term.close", terminalId });
      expect(manager.listTerminalsForUser("user-id")).toEqual([]);

      // The CLI spawned the shell just before the deadline: the late answer gets a close.
      socket.sends.length = 0;
      events = [];
      await manager.handleTextFrame(
        socket,
        JSON.stringify({ type: "term.opened", terminalId, viewerId, cliNonce: id16(5) }),
        now,
      );
      expect(control(socket)).toEqual([{ type: "term.close", terminalId }]);
      expect(events).toEqual([]);
    },
  );

  it("closes an unknown term.attached but ignores an unknown term.exit", async () => {
    const { manager, socket } = await setup();
    const terminalId = id16(22);
    socket.sends.length = 0;
    await manager.handleTextFrame(
      socket,
      JSON.stringify({ type: "term.attached", terminalId, viewerId: id16(7), cliNonce: id16(6) }),
      now,
    );
    expect(control(socket)).toEqual([{ type: "term.close", terminalId }]);

    socket.sends.length = 0;
    await manager.handleTextFrame(
      socket,
      JSON.stringify({ type: "term.exit", terminalId, exitCode: 0 }),
      now,
    );
    expect(control(socket)).toEqual([]);
    expect(events).toEqual([]);
  });

  it("sends exit to every viewer and pending tab, and drops all viewers on CLI disconnect", async () => {
    const { manager, socket } = await setup(helloCli({ terminalApproval: true }));
    const terminalId = id16(20);
    await openTerminal(manager, socket, terminalId);
    attach(manager, "b", terminalId);
    await manager.handleTextFrame(socket, JSON.stringify({ type: "term.exit", terminalId }), now);
    expect(events.at(-1)).toMatchObject({ type: "exit", connIds: ["a", "b"] });

    const second = id16(21);
    await openTerminal(manager, socket, second);
    await manager.removeSession(socket, now);
    expect(events.at(-1)).toMatchObject({ type: "exit", terminalId: second, connIds: ["a"] });
    expect(manager.listTerminalsForUser("user-id")).toEqual([]);
  });
});

describe("relay 2.7 telemetry", () => {
  const metrics = (ts: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "node.metrics",
      ts,
      cpu: { usagePercent: 12.5, load1: 0.5 },
      memory: { totalMiB: 1000, availableMiB: 500 },
      ...extra,
    });
  const load = (endpointSlug: string, running: number, modelSlug?: string) =>
    JSON.stringify({
      type: "endpoint.load",
      endpointSlug,
      ...(modelSlug ? { modelSlug } : {}),
      running,
      waiting: 0,
      kvUsage: 0.25,
      source: "vllm-metrics",
      ts: "2026-01-01T00:00:00.000Z",
    });
  const at = (ms: number) => new Date(now.getTime() + ms);

  beforeEach(() => {
    vi.clearAllMocks();
    seedRegistrationMocks();
  });

  async function registered() {
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket, identity, now });
    await manager.handleTextFrame(socket, helloFrame(), now);
    db.cliDevice.updateMany.mockClear();
    db.cliDevice.update.mockClear();
    return { manager, socket };
  }

  function telemetryWrites() {
    return db.cliDevice.updateMany.mock.calls
      .map((call) => call[0] as { where: { id: string }; data: Record<string, unknown> })
      .filter((args) => "nodeInfo" in args.data || "nodeMetrics" in args.data);
  }

  it("stores node.info once per connection and drops a repeat within a minute", async () => {
    const { manager, socket } = await registered();
    const info = JSON.stringify({ type: "node.info", nodeKind: "unified", cliVersion: "0.4.0" });
    await manager.handleTextFrame(socket, info, now);
    await manager.handleTextFrame(socket, info, at(30_000));
    expect(telemetryWrites()).toEqual([
      {
        where: { id: "cli-device-id" },
        data: { nodeInfo: { nodeKind: "unified", cliVersion: "0.4.0" }, nodeInfoAt: now },
      },
    ]);
    await manager.handleTextFrame(socket, info, at(61_000));
    expect(telemetryWrites()).toHaveLength(2);
    expect(socket.closes).toEqual([]);
    manager.dispose();
  });

  it("keeps the freshest metrics live, drops frames under 4 s apart, and persists once a minute", async () => {
    const { manager, socket } = await registered();
    await manager.handleTextFrame(socket, metrics("2026-01-01T00:00:00.000Z"), now);
    await manager.handleTextFrame(socket, metrics("2026-01-01T00:00:01.000Z"), at(1_000));
    let live = manager.getLiveNodeTelemetry(["cli-device-id"]).get("cli-device-id");
    expect(live?.nodeMetrics).toMatchObject({ ts: "2026-01-01T00:00:00.000Z" });
    expect(live?.nodeMetricsReceivedAt).toEqual(now);

    await manager.handleTextFrame(socket, metrics("2026-01-01T00:00:20.000Z"), at(20_000));
    live = manager.getLiveNodeTelemetry(["cli-device-id"]).get("cli-device-id");
    expect(live?.nodeMetrics).toMatchObject({ ts: "2026-01-01T00:00:20.000Z" });
    expect(live?.nodeMetrics).not.toHaveProperty("type");
    // Persisted for the first frame only; the next write waits a minute.
    expect(telemetryWrites()).toHaveLength(1);
    expect(telemetryWrites()[0]?.data).toMatchObject({ nodeMetricsAt: now });
    await manager.handleTextFrame(socket, metrics("2026-01-01T00:01:00.000Z"), at(60_000));
    expect(telemetryWrites()).toHaveLength(2);
    manager.dispose();
  });

  it("keeps endpoint.load in memory only, rate-limited per endpoint and model", async () => {
    const { manager, socket } = await registered();
    await manager.handleTextFrame(socket, load("vllm", 1), now);
    await manager.handleTextFrame(socket, load("vllm", 2), at(500));
    await manager.handleTextFrame(socket, load("vllm", 3, "llama"), at(600));
    await manager.handleTextFrame(socket, load("sglang", 4), at(700));
    let loads = manager.getLiveNodeTelemetry(["cli-device-id"]).get("cli-device-id")?.endpointLoad;
    expect(loads?.map((entry) => [entry.endpointSlug, entry.modelSlug, entry.running])).toEqual([
      ["vllm", null, 1],
      ["vllm", "llama", 3],
      ["sglang", null, 4],
    ]);
    await manager.handleTextFrame(socket, load("vllm", 5), at(1_500));
    loads = manager.getLiveNodeTelemetry(["cli-device-id"]).get("cli-device-id")?.endpointLoad;
    expect(loads?.[0]).toMatchObject({ running: 5, receivedAt: at(1_500) });
    expect(loads?.[0]).not.toHaveProperty("receivedAtMs");
    expect(db.cliDevice.updateMany).not.toHaveBeenCalled();
    expect(db.cliDevice.update).not.toHaveBeenCalled();
    manager.dispose();
  });

  const waitingLoad = (waiting: number, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "endpoint.load",
      endpointSlug: "vllm",
      running: 4,
      waiting,
      source: "vllm-metrics",
      ts: "2026-01-01T00:00:00.000Z",
      ...extra,
    });
  const liveLoad = (manager: InstanceType<typeof RelaySessionManager>) =>
    manager.getLiveNodeTelemetry(["cli-device-id"]).get("cli-device-id")?.endpointLoad[0];

  it("counts consecutive accepted waiting frames; zero or a gap resets the streak (S-D)", async () => {
    const { manager, socket } = await registered();
    await manager.handleTextFrame(socket, waitingLoad(2), now);
    expect(liveLoad(manager)?.waitingStreak).toBe(1);
    // A frame dropped by the 1 s limiter does not count.
    await manager.handleTextFrame(socket, waitingLoad(2), at(500));
    expect(liveLoad(manager)?.waitingStreak).toBe(1);
    await manager.handleTextFrame(socket, waitingLoad(1), at(3_000));
    expect(liveLoad(manager)?.waitingStreak).toBe(2);
    await manager.handleTextFrame(socket, waitingLoad(3), at(6_000));
    expect(liveLoad(manager)?.waitingStreak).toBe(3);
    await manager.handleTextFrame(socket, waitingLoad(0), at(9_000));
    expect(liveLoad(manager)?.waitingStreak).toBe(0);
    await manager.handleTextFrame(socket, waitingLoad(2), at(12_000));
    expect(liveLoad(manager)?.waitingStreak).toBe(1);
    // A gap longer than the staleness window restarts the count (fail open).
    await manager.handleTextFrame(socket, waitingLoad(2), at(12_000 + 16_000));
    expect(liveLoad(manager)?.waitingStreak).toBe(1);
    manager.dispose();
  });

  it("accumulates prefix cache deltas per key, including those of rate-limited frames (S-D)", async () => {
    const { manager, socket } = await registered();
    await manager.handleTextFrame(
      socket,
      waitingLoad(0, { prefixCacheHitsDelta: 10, prefixCacheQueriesDelta: 40 }),
      now,
    );
    await manager.handleTextFrame(
      socket,
      waitingLoad(0, { prefixCacheHitsDelta: 5, prefixCacheQueriesDelta: 5 }),
      at(200),
    );
    await manager.handleTextFrame(
      socket,
      waitingLoad(0, { prefixCacheHitsDelta: 1, prefixCacheQueriesDelta: 2 }),
      at(3_000),
    );
    expect(liveLoad(manager)).toMatchObject({
      prefixCacheHitsTotal: 16,
      prefixCacheQueriesTotal: 47,
    });
    manager.dispose();
  });

  it("bounds the endpoint load keys a session keeps", async () => {
    const { ENDPOINT_LOAD_MAX_KEYS } = await import("./session-manager.js");
    const { manager, socket } = await registered();
    for (let index = 0; index <= ENDPOINT_LOAD_MAX_KEYS; index += 1) {
      await manager.handleTextFrame(socket, load("vllm", index, `m${index}`), now);
    }
    const loads = manager.getLiveNodeTelemetry(["cli-device-id"]).get("cli-device-id");
    expect(loads?.endpointLoad).toHaveLength(ENDPOINT_LOAD_MAX_KEYS);
    manager.dispose();
  });

  it("drops a telemetry frame outside the strict schema without closing the session", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { manager, socket } = await registered();
    const rejected = [
      // An unknown field: nothing from it is stored or logged.
      metrics("2026-01-01T00:00:00.000Z", { stderr: "leaked" }),
      // An out-of-range reading (kernel iowait regression can push this past 100).
      metrics("2026-01-01T00:00:00.000Z", { cpu: { usagePercent: 101.3 } }),
      JSON.stringify({ type: "node.info", os: { name: "a\u0000b" } }),
      JSON.stringify({ type: "node.info", gpus: [{ index: 0, uuid: "u".repeat(129) }] }),
      JSON.stringify({ ...JSON.parse(load("vllm", 1)), running: 1_000_001 }),
    ];
    for (const frame of rejected) await manager.handleTextFrame(socket, frame, now);
    expect(socket.closes).toEqual([]);
    expect(telemetryWrites()).toEqual([]);
    expect(manager.getLiveNodeTelemetry(["cli-device-id"]).get("cli-device-id")).toEqual({
      nodeMetrics: null,
      nodeMetricsReceivedAt: null,
      endpointLoad: [],
    });
    // Logged once (per minute per session), by type only.
    expect(consoleError.mock.calls).toEqual([
      ["[relay] malformed telemetry frame dropped", "node.metrics"],
    ]);
    // The rejected frames spent no rate-limit slot: valid ones still land.
    await manager.handleTextFrame(socket, metrics("2026-01-01T00:00:01.000Z"), at(1_000));
    await manager.handleTextFrame(
      socket,
      JSON.stringify({ type: "node.info", os: { name: "Ubuntu" } }),
      at(1_000),
    );
    expect(telemetryWrites()).toHaveLength(2);
    consoleError.mockRestore();
    manager.dispose();
  });

  it("persists the metrics snapshot at most once a minute per device, across reconnects", async () => {
    const { manager, socket } = await registered();
    await manager.handleTextFrame(socket, metrics("2026-01-01T00:00:00.000Z"), now);
    // The write is conditional on the stored timestamp, so a snapshot stored
    // by an earlier session (or another instance) inside the window wins.
    expect(telemetryWrites()).toEqual([
      {
        where: {
          OR: [{ nodeMetricsAt: null }, { nodeMetricsAt: { lte: at(-60_000) } }],
          id: "cli-device-id",
        },
        data: expect.objectContaining({ nodeMetricsAt: now }),
      },
    ]);
    manager.dispose();
  });

  const fansSource = {
    name: "fans",
    command: "sensors -j",
    intervalSecs: 10,
    timeoutSecs: 5,
    format: "json",
  };
  function sourceFrames(socket: FakeSocket) {
    return socket.sends
      .map((send) => JSON.parse(String(send)) as { type: string; sources?: unknown[] })
      .filter((frame) => frame.type === "metrics.sources.set");
  }

  it("sends remote metric sources after hello.ok only while the device is unsupervised", async () => {
    const findUnique = (prisma as unknown as { cliDevice: { findUnique: MockInstance } }).cliDevice
      .findUnique;
    findUnique.mockResolvedValue({
      userId: "user-id",
      mcpCommandMode: "UNSUPERVISED",
      remoteMetricSources: [fansSource],
    });
    const unsupervised = await registered();
    expect(JSON.parse(String(unsupervised.socket.sends[0]))).toMatchObject({ type: "hello.ok" });
    expect(sourceFrames(unsupervised.socket)).toEqual([
      expect.objectContaining({ type: "metrics.sources.set", sources: [fansSource] }),
    ]);
    unsupervised.manager.dispose();

    findUnique.mockResolvedValue({
      userId: "user-id",
      mcpCommandMode: "SUPERVISED",
      remoteMetricSources: [fansSource],
    });
    const supervised = await registered();
    expect(sourceFrames(supervised.socket)).toEqual([
      expect.objectContaining({ type: "metrics.sources.set", sources: [] }),
    ]);
    supervised.manager.dispose();
  });

  it("orders remote source sends: a withdrawal is never overtaken by an older read", async () => {
    const findUnique = (prisma as unknown as { cliDevice: { findUnique: MockInstance } }).cliDevice
      .findUnique;
    findUnique.mockResolvedValue({
      userId: "user-id",
      mcpCommandMode: "SUPERVISED",
      remoteMetricSources: [fansSource],
    });
    const { manager, socket } = await registered();
    socket.sends.length = 0;
    // The first read is slow and sees the old (unsupervised) state; the
    // mode is then lowered and a second send is requested.
    const readsBefore = findUnique.mock.calls.length;
    let release: (value: unknown) => void = () => undefined;
    findUnique.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = manager.onRemoteMetricSourcesChanged("cli-device-id");
    // The first send's read is in flight before the mode changes.
    await vi.waitFor(() => expect(findUnique).toHaveBeenCalledTimes(1 + readsBefore));
    findUnique.mockResolvedValue({
      userId: "user-id",
      mcpCommandMode: "SUPERVISED",
      remoteMetricSources: [fansSource],
    });
    const second = manager.onRemoteMetricSourcesChanged("cli-device-id");
    release({
      userId: "user-id",
      mcpCommandMode: "UNSUPERVISED",
      remoteMetricSources: [fansSource],
    });
    await Promise.all([first, second]);
    const frames = sourceFrames(socket).map((frame) => frame.sources);
    expect(frames.at(-1)).toEqual([]);
    manager.dispose();
  });

  it("fails closed: a failed device read withdraws the sources and reports no delivery", async () => {
    const findUnique = (prisma as unknown as { cliDevice: { findUnique: MockInstance } }).cliDevice
      .findUnique;
    findUnique.mockResolvedValue({
      userId: "user-id",
      mcpCommandMode: "UNSUPERVISED",
      remoteMetricSources: [fansSource],
    });
    const { manager, socket } = await registered();
    expect(sourceFrames(socket).map((frame) => frame.sources)).toEqual([[fansSource]]);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const failure of [
      () => findUnique.mockRejectedValueOnce(new Error("db down")),
      () => findUnique.mockResolvedValueOnce(null),
      () =>
        findUnique.mockResolvedValueOnce({
          userId: "someone-else",
          mcpCommandMode: "UNSUPERVISED",
          remoteMetricSources: [fansSource],
        }),
    ]) {
      socket.sends.length = 0;
      failure();
      await expect(manager.onRemoteMetricSourcesChanged("cli-device-id")).resolves.toBe(false);
      expect(sourceFrames(socket).map((frame) => frame.sources)).toEqual([[]]);
    }
    consoleError.mockRestore();
    // A healthy read afterwards delivers again.
    socket.sends.length = 0;
    await expect(manager.onRemoteMetricSourcesChanged("cli-device-id")).resolves.toBe(true);
    expect(sourceFrames(socket).map((frame) => frame.sources)).toEqual([[fansSource]]);
    manager.dispose();
  });

  it("clears a pool's verdicts through the H module when its rules change", async () => {
    const deep = prisma as unknown as {
      poolMemberRoutingVerdict: { deleteMany: MockInstance };
    };
    deep.poolMemberRoutingVerdict.deleteMany.mockResolvedValue({ count: 1 });
    const manager = new RelaySessionManager();
    await manager.onPoolRoutingRulesChanged("pool-1");
    expect(deep.poolMemberRoutingVerdict.deleteMany).toHaveBeenCalledWith({
      where: { poolId: "pool-1", verdict: { not: "NONE" } },
    });
    manager.dispose();
  });

  it("withdraws the sources on a mode downgrade even when the grant re-read fails", async () => {
    const findUnique = (prisma as unknown as { cliDevice: { findUnique: MockInstance } }).cliDevice
      .findUnique;
    findUnique.mockResolvedValue({
      userId: "user-id",
      mcpCommandMode: "UNSUPERVISED",
      remoteMetricSources: [fansSource],
    });
    const { manager, socket } = await registered();
    socket.sends.length = 0;
    // The downgrade is committed; the hook's own grant read fails, the
    // push's read (a later call) sees the committed OFF mode.
    findUnique.mockRejectedValueOnce(new Error("db down"));
    findUnique.mockResolvedValue({
      userId: "user-id",
      mcpCommandMode: "OFF",
      remoteMetricSources: [fansSource],
    });
    await expect(manager.onCliFeatureGrantsChanged("cli-device-id")).rejects.toThrow("db down");
    expect(sourceFrames(socket).map((frame) => frame.sources)).toEqual([[]]);
    manager.dispose();
  });

  it("never sends an oversized remote source list: the CLI gets an empty one", async () => {
    const findUnique = (prisma as unknown as { cliDevice: { findUnique: MockInstance } }).cliDevice
      .findUnique;
    findUnique.mockResolvedValue({
      userId: "user-id",
      mcpCommandMode: "UNSUPERVISED",
      remoteMetricSources: Array.from({ length: 51 }, (_, index) => ({
        ...fansSource,
        name: `source-${index}`,
      })),
    });
    const { manager, socket } = await registered();
    expect(sourceFrames(socket).map((frame) => frame.sources)).toEqual([[]]);
    manager.dispose();
  });

  it("withdraws remote metric sources when the MCP command mode is lowered", async () => {
    const findUnique = (prisma as unknown as { cliDevice: { findUnique: MockInstance } }).cliDevice
      .findUnique;
    findUnique.mockResolvedValue({
      userId: "user-id",
      allowHumanTerminal: false,
      mcpCommandMode: "UNSUPERVISED",
      remoteMetricSources: [fansSource],
    });
    const { manager, socket } = await registered();
    findUnique.mockResolvedValue({
      userId: "user-id",
      allowHumanTerminal: false,
      mcpCommandMode: "OFF",
      remoteMetricSources: [fansSource],
    });
    await manager.onCliFeatureGrantsChanged("cli-device-id");
    expect(sourceFrames(socket).map((frame) => frame.sources)).toEqual([[fansSource], []]);
    // Changing the definitions pushes them to the live session.
    expect(await manager.onRemoteMetricSourcesChanged("cli-device-id")).toBe(true);
    expect(await manager.onRemoteMetricSourcesChanged("other-device")).toBe(false);
    manager.dispose();
  });

  it("evaluates pool routing rules on node.metrics and writes the member verdict", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const deep = prisma as unknown as {
        poolMember: { findMany: MockInstance };
        modelPool: { findMany: MockInstance };
        poolMemberRoutingVerdict: { updateMany: MockInstance; create: MockInstance };
      };
      const routingRules = [
        { metric: "node.cpu.usage_percent", op: ">", threshold: 10, effect: "full" },
      ];
      deep.modelPool.findMany.mockResolvedValue([{ id: "pool-1", routingRules }]);
      deep.poolMember.findMany.mockResolvedValue([
        {
          id: "member-1",
          poolId: "pool-1",
          ModelPool: {
            routingRules,
          },
          DiscoveredModel: null,
          ExecutionTarget: { DiscoveredModel: { slug: null, Endpoint: { slug: "example" } } },
        },
      ]);
      deep.poolMemberRoutingVerdict.updateMany.mockResolvedValue({ count: 0 });
      deep.poolMemberRoutingVerdict.create.mockResolvedValue({});
      const { manager, socket } = await registered();
      await manager.handleTextFrame(socket, metrics("2026-01-01T00:00:00.000Z"), now);
      await vi.advanceTimersByTimeAsync(0);
      expect(deep.poolMemberRoutingVerdict.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          poolMemberId: "member-1",
          verdict: "FULL",
          cliDeviceId: "cli-device-id",
          userId: "user-id",
        }),
      });
      manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("evaluates pool routing on an endpoint.load frame and writes the engine-load verdict (S-D)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const deep = prisma as unknown as {
        poolMember: { findMany: MockInstance };
        modelPool: { findMany: MockInstance };
        poolMemberRoutingVerdict: { updateMany: MockInstance; create: MockInstance };
      };
      deep.modelPool.findMany.mockResolvedValue([]);
      deep.poolMember.findMany.mockResolvedValue([
        {
          id: "member-1",
          poolId: "pool-1",
          engineLoadMode: "AUTO",
          kvFullThreshold: null,
          ModelPool: { routingRules: [] },
          DiscoveredModel: null,
          ExecutionTarget: {
            InferenceCapacity: { engineKind: "VLLM", engineSlots: null },
            DiscoveredModel: { slug: null, Endpoint: { slug: "vllm" } },
          },
        },
      ]);
      deep.poolMemberRoutingVerdict.updateMany.mockResolvedValue({ count: 0 });
      deep.poolMemberRoutingVerdict.create.mockResolvedValue({});
      const { manager, socket } = await registered();
      // The first accepted waiting frame is streak 1: below the sustained
      // threshold, the evaluation publishes only the successor NONE fence.
      await manager.handleTextFrame(socket, waitingLoad(2), now);
      await vi.advanceTimersByTimeAsync(0);
      expect(deep.poolMemberRoutingVerdict.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ verdict: "NONE", engineState: "clear" }),
      });
      // A second accepted frame within the staleness window makes streak 2.
      vi.setSystemTime(at(3_000));
      await manager.handleTextFrame(socket, waitingLoad(2), at(3_000));
      await vi.advanceTimersByTimeAsync(0);
      expect(deep.poolMemberRoutingVerdict.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          poolMemberId: "member-1",
          verdict: "FULL",
          engineState: "full_waiting",
          cliDeviceId: "cli-device-id",
          userId: "user-id",
        }),
      });
      manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not schedule an evaluation for an endpoint.load frame the limiter drops (S-D)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const deep = prisma as unknown as {
        poolMember: { findMany: MockInstance };
        modelPool: { findMany: MockInstance };
      };
      deep.poolMember.findMany.mockResolvedValue([]);
      deep.modelPool.findMany.mockResolvedValue([]);
      // The recovery scheduler also reads poolMember on its own timer; the
      // routing evaluation is the only reader filtering on `tier`.
      const routingRuns = () =>
        deep.poolMember.findMany.mock.calls.filter(
          (call) => (call[0] as { where?: { tier?: string } }).where?.tier === "PRIMARY",
        ).length;
      const { manager, socket } = await registered();
      await manager.handleTextFrame(socket, waitingLoad(2), now);
      await vi.advanceTimersByTimeAsync(0);
      expect(routingRuns()).toBe(1);
      // Inside the 1 s limiter the frame is dropped: no evaluation now and no
      // trailing one either, so advancing past the window changes nothing.
      await manager.handleTextFrame(socket, waitingLoad(2), at(500));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(routingRuns()).toBe(1);
      manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a replaced session runs no pending evaluation after its successor's hello (S-D)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const deep = prisma as unknown as {
        poolMember: { findMany: MockInstance };
        modelPool: { findMany: MockInstance };
      };
      deep.poolMember.findMany.mockResolvedValue([]);
      deep.modelPool.findMany.mockResolvedValue([]);
      const routingRuns = () =>
        deep.poolMember.findMany.mock.calls.filter(
          (call) => (call[0] as { where?: { tier?: string } }).where?.tier === "PRIMARY",
        ).length;
      const { manager, socket } = await registered();
      await manager.handleTextFrame(socket, waitingLoad(2), now);
      await vi.advanceTimersByTimeAsync(0);
      expect(routingRuns()).toBe(1);
      // A second frame inside the 1 s window leaves a trailing run pending.
      vi.setSystemTime(at(1_100));
      await manager.handleTextFrame(socket, waitingLoad(2), at(1_100));
      // The CLI reconnects before the old socket closed: the old session is
      // replaced and its pending run must never publish over the successor.
      const successor = new FakeSocket();
      manager.acceptAuthenticatedSocket({ socket: successor, identity, now: at(1_100) });
      await manager.handleTextFrame(successor, helloFrame(), at(1_100));
      expect(socket.closes).toEqual([{ code: 1000, reason: "replaced" }]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(routingRuns()).toBe(1);
      manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires registration before telemetry", async () => {
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket, identity, now });
    await manager.handleTextFrame(socket, load("vllm", 1), now);
    expect(socket.closes).toEqual([{ code: 1002, reason: "protocol_error" }]);
    expect(manager.getLiveNodeTelemetry(["cli-device-id"]).size).toBe(0);
    manager.dispose();
  });

  it("still closes an unregistered socket that sends malformed telemetry", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket, identity, now });
    await manager.handleTextFrame(
      socket,
      metrics("2026-01-01T00:00:00.000Z", { cpu: { usagePercent: 101.3 } }),
      now,
    );
    expect(socket.closes).toEqual([{ code: 1002, reason: "protocol_error" }]);
    expect(consoleError).not.toHaveBeenCalledWith(
      "[relay] malformed telemetry frame dropped",
      "node.metrics",
    );
    consoleError.mockRestore();
    manager.dispose();
  });
});
