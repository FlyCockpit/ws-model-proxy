import type { WebSocketLike } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RELAY_PROTOCOL_VERSIONS, RELAY_SUBPROTOCOL } from "./protocol.js";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_URL: "https://proxy.example.test",
    WMP_RATE_LIMIT_SCALE: 1,
    TRUST_PROXY_HOPS: undefined,
  },
}));

vi.mock("./node-credential-auth.js", () => ({
  authenticateNodeCredential: vi.fn(),
}));

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const limiterState = vi.hoisted(() => ({ hits: 0, limit: Number.POSITIVE_INFINITY }));

vi.mock("../rate-limit.js", () => ({
  authLimiter: {},
  createRateLimiterMiddleware:
    () =>
    async (c: { json: (body: unknown, status: number) => Response }, next: () => Promise<void>) => {
      limiterState.hits += 1;
      if (limiterState.hits > limiterState.limit) {
        return c.json({ error: "Too many attempts. Please wait a moment and try again." }, 429);
      }
      await next();
    },
}));

const { authenticateNodeCredential } = await import("./node-credential-auth.js");
const { createRelayWebsocketMiddleware, relaySocketEvents } = await import("./websocket.js");
const { relaySessionManager } = await import("./session-manager.js");
const { WSContext } = await import("hono/ws");

const authenticateMock = vi.mocked(authenticateNodeCredential);

function app() {
  const hono = new Hono();
  hono.use("/api/cli/ws", createRelayWebsocketMiddleware());
  hono.get("/api/cli/ws", (c) => c.text("ok"));
  return hono;
}

function websocketHeaders(extra: Record<string, string> = {}) {
  return {
    Upgrade: "websocket",
    "Sec-WebSocket-Protocol": RELAY_SUBPROTOCOL,
    ...extra,
  };
}

describe("createRelayWebsocketMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limiterState.hits = 0;
    limiterState.limit = Number.POSITIVE_INFINITY;
  });

  it("rejects unauthenticated websocket upgrades", async () => {
    const response = await app().request("/api/cli/ws", {
      method: "GET",
      headers: websocketHeaders(),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Node credential required.",
    });
  });

  it("rejects unsupported relay protocol versions before upgrade", async () => {
    const response = await app().request("/api/cli/ws", {
      method: "GET",
      headers: websocketHeaders({
        Authorization: "Bearer wsmp_node_secret",
        "Sec-WebSocket-Protocol": "ws-model-proxy.relay.v2",
      }),
    });

    expect(response.status).toBe(426);
    await expect(response.json()).resolves.toMatchObject({
      type: "protocol.error",
      failure: "protocol_error",
      code: "upgrade_cli",
      supportedVersions: RELAY_PROTOCOL_VERSIONS,
      supportedSubprotocol: "ws-model-proxy.relay.v3",
    });
  });

  it("returns a 429 from the limiter and does not continue the upgrade", async () => {
    limiterState.limit = 0;
    let continued = false;
    const hono = new Hono();
    hono.use("/api/cli/ws", createRelayWebsocketMiddleware());
    hono.get("/api/cli/ws", (c) => {
      continued = true;
      return c.text("ok");
    });

    const response = await hono.request("/api/cli/ws", {
      method: "GET",
      headers: websocketHeaders({ Authorization: "Bearer wsmp_node_secret" }),
    });

    expect(response.status).toBe(429);
    expect(continued).toBe(false);
    expect(authenticateMock).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: "Too many attempts. Please wait a moment and try again.",
    });
  });

  it("rejects revoked websocket credentials", async () => {
    authenticateMock.mockResolvedValue(null);

    const response = await app().request("/api/cli/ws", {
      method: "GET",
      headers: websocketHeaders({ Authorization: "Bearer wsmp_node_secret" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid or revoked node credential.",
    });
  });
});

describe("relay upgrade during shutdown", () => {
  const identity: Parameters<typeof relaySocketEvents>[0] = {
    credentialId: "cred-id",
    userId: "user-id",
    nodeId: "node-id",
    identityPublicKey: "key",
  };

  function fakeWs() {
    const closes: Array<{ code?: number; reason?: string }> = [];
    const raw = {
      readyState: 1 as 0 | 1 | 2 | 3,
      send: () => undefined,
      close: (code?: number, reason?: string) => {
        closes.push({ code, reason });
      },
    };
    return { ws: new WSContext<WebSocketLike>(raw), closes };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    limiterState.hits = 0;
    limiterState.limit = Number.POSITIVE_INFINITY;
  });

  afterEach(() => {
    // Test hygiene only: production never clears the flag.
    Reflect.set(relaySessionManager, "relayDrain", false);
  });

  const sessionCount = () =>
    (Reflect.get(relaySessionManager, "sessionsBySocket") as Map<unknown, unknown>).size;

  it("closes with the shutdown code and never registers a socket whose authentication finishes after the drain began", async () => {
    let finishAuth: (value: typeof identity) => void = () => {};
    authenticateMock.mockReturnValue(
      new Promise((resolve) => {
        finishAuth = resolve as typeof finishAuth;
      }),
    );
    const hono = new Hono();
    hono.use("/api/cli/ws", createRelayWebsocketMiddleware());
    let handlerIdentity: typeof identity | undefined;
    hono.get("/api/cli/ws", (c) => {
      handlerIdentity = (c as unknown as { get: (k: string) => typeof identity }).get(
        "relayIdentity",
      );
      return c.text("upgraded");
    });

    // The drain check passed; authentication is now in flight.
    const upgrade = hono.request("/api/cli/ws", {
      method: "GET",
      headers: websocketHeaders({ Authorization: "Bearer wsmp_node_secret" }),
    });
    await vi.waitFor(() => expect(authenticateMock).toHaveBeenCalledTimes(1));
    expect(relaySessionManager.isDraining()).toBe(false);
    relaySessionManager.beginDrain();
    finishAuth(identity);
    expect((await upgrade).status).toBe(200);
    expect(handlerIdentity).toBe(identity);

    // The upgrade completes: onOpen runs for the authenticated socket.
    const { ws, closes } = fakeWs();
    relaySocketEvents(handlerIdentity as typeof identity).onOpen?.(new Event("open"), ws);
    expect(closes).toEqual([{ code: 1001, reason: "shutdown" }]);
    expect(sessionCount()).toBe(0);
  });

  it("still registers a socket that opens before the drain", async () => {
    const { ws, closes } = fakeWs();
    relaySocketEvents(identity).onOpen?.(new Event("open"), ws);
    try {
      expect(closes).toEqual([]);
      expect(sessionCount()).toBe(1);
    } finally {
      relaySocketEvents(identity).onClose?.(new CloseEvent("close"), ws);
      await vi.waitFor(() => expect(sessionCount()).toBe(0));
    }
  });
});
