import type { CliWebsocketIdentity } from "@ws-model-proxy/api/lib/cli-credential-access";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseRelayBinaryFrame,
  RELAY_REQUEST_BODY_WINDOW_CHUNKS,
  RELAY_STALE_AFTER_MS,
} from "./protocol.js";

const WS_READY_STATE_OPEN = 1;

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { RelaySessionManager } = await import("./session-manager.js");
const { default: prisma } = await import("@ws-model-proxy/db");

const db = prisma as unknown as {
  user: {
    findUnique: MockInstance;
  };
  cliDevice: {
    upsert: MockInstance;
    update: MockInstance;
  };
  cliToken: {
    update: MockInstance;
  };
  endpoint: {
    upsert: MockInstance;
  };
  discoveredModel: {
    upsert: MockInstance;
  };
  poolMember: {
    updateMany: MockInstance;
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

function helloFrame() {
  return JSON.stringify({
    type: "hello",
    id: "hello-id",
    protocolVersion: "2.0",
    cli: {
      slug: "desktop",
      label: "Desktop",
      capabilities: {
        protocolVersion: "2.0",
        binaryFrames: true,
        cancellation: true,
        maxBinaryChunkBytes: 1024 * 1024,
        requestBodyStreaming: true,
        requestBodyWindowChunks: RELAY_REQUEST_BODY_WINDOW_CHUNKS,
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
  db.user.findUnique.mockResolvedValue({ id: "user-id", slug: "owner" });
  db.cliDevice.upsert.mockResolvedValue({
    id: "cli-device-id",
    userId: "user-id",
    slug: "desktop",
  });
  db.cliToken.update.mockResolvedValue({ id: "token-id" });
  db.endpoint.upsert.mockResolvedValue({ id: "endpoint-id", slug: "local-openai" });
  db.discoveredModel.upsert.mockResolvedValue({ id: "model-id" });
  db.poolMember.updateMany.mockResolvedValue({ count: 1 });
}

describe("RelaySessionManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    seedRegistrationMocks();
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
      protocolVersion: "2.0",
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
        discoveredModelId: { in: ["model-id"] },
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

    expect(db.cliDevice.update).toHaveBeenCalledWith({
      where: { id: "cli-device-id" },
      data: { status: "CONNECTED", lastHeartbeatAt: heartbeatAt },
      select: { id: true },
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

    expect(db.cliDevice.update).toHaveBeenCalledWith({
      where: { id: "cli-device-id" },
      data: { status: "DISCONNECTED", lastDisconnectedAt: closedAt },
      select: { id: true },
    });
    expect(db.poolMember.updateMany).toHaveBeenLastCalledWith({
      where: {
        DiscoveredModel: {
          Endpoint: { cliDeviceId: "cli-device-id" },
        },
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

  it("marks stale sessions and their pool members unavailable", async () => {
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket, identity, now });
    await manager.handleTextFrame(socket, helloFrame(), now);

    const staleAt = new Date(now.getTime() + RELAY_STALE_AFTER_MS + 1);
    await manager.checkStaleSessions(staleAt);

    expect(socket.closes).toEqual([{ code: 1001, reason: "stale" }]);
    expect(db.cliDevice.update).toHaveBeenCalledWith({
      where: { id: "cli-device-id" },
      data: { status: "STALE", lastDisconnectedAt: staleAt },
      select: { id: true },
    });
    expect(db.poolMember.updateMany).toHaveBeenLastCalledWith({
      where: {
        DiscoveredModel: {
          Endpoint: { cliDeviceId: "cli-device-id" },
        },
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
    expect(firstChunk.metadata.final ?? false).toBe(false);

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
