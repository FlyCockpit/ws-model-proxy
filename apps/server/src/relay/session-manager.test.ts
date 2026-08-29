import type { CliWebsocketIdentity } from "@ws-model-proxy/api/lib/cli-credential-access";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseMultipartToSpool } from "../model-api/multipart-form-data.js";
import {
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
}

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
      protocolVersion: "2.3",
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
    expect(parseRelayBinaryFrame(socket.sends[1] as ArrayBuffer).metadata.final).toBe(true);
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
