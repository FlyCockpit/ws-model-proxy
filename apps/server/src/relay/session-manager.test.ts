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
  };
  cliToken: {
    update: MockInstance;
  };
  endpoint: {
    upsert: MockInstance;
    findUnique: MockInstance;
    updateMany: MockInstance;
  };
  discoveredModel: {
    findUnique: MockInstance;
    findMany: MockInstance;
    upsert: MockInstance;
    updateMany: MockInstance;
  };
  poolMember: {
    updateMany: MockInstance;
  };
  executionTarget: {
    upsert: MockInstance;
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

function helloFrame() {
  return JSON.stringify({
    type: "hello",
    id: "hello-id",
    protocolVersion: "2.1",
    cli: {
      slug: "desktop",
      label: "Desktop",
      capabilities: {
        protocolVersion: "2.1",
        inventoryAck: true,
        inventoryReplace: true,
        endpointTargeting: true,
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
  db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) => callback(db));
  db.user.findUnique.mockResolvedValue({ id: "user-id", slug: "owner" });
  db.cliDevice.upsert.mockResolvedValue({
    id: "cli-device-id",
    userId: "user-id",
    slug: "desktop",
  });
  db.cliToken.update.mockResolvedValue({ id: "token-id" });
  db.cliDevice.update.mockResolvedValue({
    inventorySeq: 1,
    inventoryDigest: "digest",
    inventoryAcknowledgedAt: now,
    id: "cli-device-id",
  });
  db.endpoint.findUnique.mockResolvedValue(null);
  db.endpoint.upsert.mockResolvedValue({ id: "endpoint-id", slug: "local-openai" });
  db.endpoint.updateMany.mockResolvedValue({ count: 0 });
  db.discoveredModel.findUnique.mockResolvedValue(null);
  db.discoveredModel.findMany.mockResolvedValue([]);
  db.discoveredModel.upsert.mockResolvedValue({ id: "model-id" });
  db.discoveredModel.updateMany.mockResolvedValue({ count: 0 });
  db.poolMember.updateMany.mockResolvedValue({ count: 1 });
  db.executionTarget.upsert.mockResolvedValue({
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

    db.cliDevice.update.mockImplementation(() => new Promise(() => {}));
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

  it("retries a serializable inventory conflict so an identical snapshot keeps one revision", async () => {
    const parsed = parseRelayClientControlFrame(helloFrame());
    if (parsed.type !== "hello") throw new Error("expected hello frame");
    const conflict = Object.assign(new Error("serialization failure"), { code: "P2034" });
    db.$transaction.mockImplementationOnce(async () => {
      throw conflict;
    });

    const registration = await persistRelayRegistration({
      identity,
      cli: { slug: parsed.cli.slug, label: parsed.cli.label },
      endpoints: parsed.endpoints,
      inventoryConfirmed: true,
      endpointTargeting: true,
      now,
    });

    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(db.$transaction).toHaveBeenLastCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
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
      protocolVersion: "2.1",
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
        OR: [
          {
            executionTargetId: { not: null },
            ExecutionTarget: { DiscoveredModel: { Endpoint: { cliDeviceId: "cli-device-id" } } },
          },
          {
            executionTargetId: null,
            DiscoveredModel: { Endpoint: { cliDeviceId: "cli-device-id" } },
          },
        ],
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
        OR: [
          {
            executionTargetId: { not: null },
            ExecutionTarget: { DiscoveredModel: { Endpoint: { cliDeviceId: "cli-device-id" } } },
          },
          {
            executionTargetId: null,
            DiscoveredModel: { Endpoint: { cliDeviceId: "cli-device-id" } },
          },
        ],
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
      protocolVersion: "2.1",
      cli: {
        slug: "desktop",
        label: "Desktop",
        capabilities: {
          protocolVersion: "2.1",
          inventoryAck: true,
          inventoryReplace: true,
          endpointTargeting: true,
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

function hello24(features?: {
  humanTerminal?: boolean;
  mcpCommands?: boolean;
  terminalApproval?: boolean;
  terminalSupported?: boolean;
}) {
  return JSON.stringify({
    type: "hello",
    id: "hello-24",
    protocolVersion: "2.4",
    cli: {
      slug: "desktop",
      label: "Desktop",
      version: "9.9.9",
      capabilities: {
        protocolVersion: "2.4",
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
          humanTerminal: true,
          mcpCommands: true,
          terminalApproval: false,
          terminalSupported: true,
          ...features,
        },
        terminalPublicKey: uncompressedKey(),
      },
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
      allowMcpCommands: true,
    });
  });

  async function register(
    manager: InstanceType<typeof RelaySessionManager>,
    socket: FakeSocket,
    frame = hello24(),
  ) {
    manager.acceptAuthenticatedSocket({ socket, identity, now });
    await manager.handleTextFrame(socket, frame, now);
    return socket;
  }

  it("echoes the client protocol version and persists reported columns only from hello", async () => {
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    await register(manager, socket, helloFrame());
    expect(JSON.parse(String(socket.sends[0])).protocolVersion).toBe("2.1");
    expect(db.cliDevice.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          cliVersion: null,
          relayProtocolVersion: "2.1",
          reportedHumanTerminal: null,
          reportedMcpCommands: null,
          reportedTerminalApproval: null,
          reportedTerminalSupported: null,
          featuresReportedAt: null,
        }),
      }),
    );
    expect(db.cliDevice.upsert.mock.calls[0]?.[0].update).not.toHaveProperty("allowHumanTerminal");
    expect(db.cliDevice.upsert.mock.calls[0]?.[0].update).not.toHaveProperty("allowMcpCommands");

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
    expect(db.cliDevice.upsert.mock.calls[0]?.[0].update).not.toHaveProperty("cliVersion");

    const next = new FakeSocket();
    await register(manager, next);
    expect(JSON.parse(String(next.sends[0])).protocolVersion).toBe("2.4");
    expect(db.cliDevice.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          cliVersion: "9.9.9",
          relayProtocolVersion: "2.4",
          reportedHumanTerminal: true,
          reportedMcpCommands: true,
          reportedTerminalApproval: false,
          reportedTerminalSupported: true,
          featuresReportedAt: now,
        }),
      }),
    );
  });

  it("does not send term or exec frames to a CLI below 2.4", async () => {
    const manager = new RelaySessionManager();
    const socket = new FakeSocket();
    await register(manager, socket, helloFrame());
    socket.sends.length = 0;
    expect(
      manager.startTerminal({
        terminalId: id16(),
        userId: "user-id",
        cliDeviceId: "cli-device-id",
        label: "Desktop",
        cols: 80,
        rows: 24,
        browserPublicKey: uncompressedKey(),
        browserNonce: id16(4),
        connId: "viewer",
      }),
    ).toBe(false);
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
    expect(manager.dispatchExecStart(command, { command: "pwd" })).toBe(false);
    expect(socket.sends).toEqual([]);
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
        label: "Desktop",
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
      allowHumanTerminal: false,
      allowMcpCommands: false,
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
      allowMcpCommands: true,
    });
    const again = new FakeSocket();
    await register(manager, again);
    const secondTerminal = id16(9);
    manager.startTerminal({
      terminalId: secondTerminal,
      userId: "user-id",
      cliDeviceId: "cli-device-id",
      label: "Desktop",
      cols: 80,
      rows: 24,
      browserPublicKey: uncompressedKey(),
      browserNonce: id16(4),
      connId: "viewer-2",
    });
    const replacement = new FakeSocket();
    manager.acceptAuthenticatedSocket({ socket: replacement, identity, now });
    await manager.handleTextFrame(replacement, hello24(), now);
    expect(again.closes).toEqual([{ code: 1000, reason: "replaced" }]);
    expect(
      again.sends
        .filter((send) => typeof send === "string")
        .some((send) => JSON.parse(String(send)).type === "term.close"),
    ).toBe(true);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ failure: "disconnected" }));
    expect(db.cliDevice.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "DISCONNECTED" }) }),
    );

    const survivor = new FakeSocket();
    await register(manager, survivor);
    manager.startTerminal({
      terminalId: id16(10),
      userId: "user-id",
      cliDeviceId: "cli-device-id",
      label: "Desktop",
      cols: 40,
      rows: 12,
      browserPublicKey: uncompressedKey(),
      browserNonce: id16(4),
      connId: "viewer-3",
    });
    await manager.removeSession(survivor, now);
    expect(db.cliDevice.update).toHaveBeenCalledWith(
      expect.objectContaining({
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
      label: "Desktop",
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

function hello25(features?: { terminalApproval?: boolean; mcpCommands?: boolean }) {
  const frame = JSON.parse(hello24(features)) as {
    id: string;
    protocolVersion: string;
    cli: { capabilities: Record<string, unknown> };
  };
  frame.id = "hello-25";
  frame.protocolVersion = "2.5";
  frame.cli.capabilities.protocolVersion = "2.5";
  frame.cli.capabilities.terminalViewers = true;
  return JSON.stringify(frame);
}

describe("relay protocol 2.5 terminal viewers", () => {
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
      allowMcpCommands: true,
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

  async function setup(frame = hello25()) {
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
        label: "Desktop",
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

  it("keeps MCP commands and terminal keys for a 2.5 CLI and persists the version", async () => {
    const { manager } = await setup();
    expect(db.cliDevice.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          relayProtocolVersion: "2.5",
          reportedMcpCommands: true,
          reportedHumanTerminal: true,
        }),
      }),
    );
    expect(manager.getLiveCliFeatures(["cli-device-id"]).get("cli-device-id")).toMatchObject({
      protocolVersion: "2.5",
      mcpCommands: true,
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

  it("keeps a 2.5 CLI identity proof for the terminal list", async () => {
    const identityKey = Buffer.alloc(65, 3);
    identityKey[0] = 0x04;
    const terminalIdentity = {
      publicKey: identityKey.toString("base64url"),
      signature: Buffer.alloc(64, 7).toString("base64url"),
    };
    const frame = JSON.parse(hello25()) as { cli: { capabilities: Record<string, unknown> } };
    frame.cli.capabilities.terminalIdentity = terminalIdentity;
    const { manager } = await setup(JSON.stringify(frame));
    expect(manager.getLiveCliFeatures(["cli-device-id"]).get("cli-device-id")).toMatchObject({
      terminalPublicKey: uncompressedKey(),
      terminalIdentity,
    });
  });

  it("reports no identity for a 2.5 CLI that sent none", async () => {
    const { manager } = await setup();
    expect(
      manager.getLiveCliFeatures(["cli-device-id"]).get("cli-device-id")?.terminalIdentity,
    ).toBeNull();
  });

  it("lets two 2.5 viewers coexist without a detached event", async () => {
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
    const { manager, socket } = await setup(hello25({ terminalApproval: true }));
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
    const { manager, socket } = await setup(hello25({ terminalApproval: true }));
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
    const { manager, socket } = await setup(hello25({ terminalApproval: true }));
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
    const { manager, socket } = await setup(hello25({ terminalApproval: true }));
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

  it.each([
    ["2.4", hello24({ terminalApproval: true })],
    ["2.5", hello25({ terminalApproval: true })],
  ])(
    "closes an expired approval handshake on the %s CLI and a late term.opened",
    async (_, frame) => {
      const { manager, socket } = await setup(frame);
      const terminalId = id16(20);
      expect(
        manager.startTerminal({
          terminalId,
          userId: "user-id",
          cliDeviceId: "cli-device-id",
          label: "Desktop",
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
    const { manager, socket } = await setup(hello25({ terminalApproval: true }));
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

  it("keeps the 2.4 steal: a second attach replaces the viewer with a detached event", async () => {
    const { manager, socket } = await setup(hello24());
    const terminalId = id16(20);
    manager.startTerminal({
      terminalId,
      userId: "user-id",
      cliDeviceId: "cli-device-id",
      label: "Desktop",
      cols: 80,
      rows: 24,
      browserPublicKey: uncompressedKey(),
      browserNonce: id16(4),
      connId: "a",
    });
    expect(control(socket).at(-1)).not.toHaveProperty("viewerId");
    await manager.handleTextFrame(
      socket,
      JSON.stringify({ type: "term.opened", terminalId, cliNonce: id16(5) }),
      now,
    );
    expect(attach(manager, "b", terminalId).ok).toBe(true);
    expect(control(socket).at(-1)).toEqual({
      type: "term.attach",
      terminalId,
      browserPublicKey: uncompressedKey(),
      browserNonce: id16(4),
    });
    expect(events).toContainEqual({ type: "detached", terminalId, connId: "a" });
    expect(events.some((event) => event.type === "viewers")).toBe(false);
    events = [];
    manager.handleBinaryFrame(
      socket,
      encodeRelayBinaryFrame({ type: "term.sealed", terminalId, seq: 1 }, new Uint8Array([1])),
    );
    expect(events).toEqual([expect.objectContaining({ type: "sealed", connIds: ["b"] })]);
    expect(manager.forwardBrowserSealed(terminalId, "user-id", "b", 1, new Uint8Array([1]))).toBe(
      "sent",
    );
    expect(parseRelayBinaryFrame(socket.sends.at(-1) as ArrayBuffer).metadata).toEqual({
      type: "term.sealed",
      terminalId,
      seq: 1,
    });
    expect(manager.forwardBrowserSealed(terminalId, "user-id", "a", 2, new Uint8Array([1]))).toBe(
      "missing",
    );
  });
});
