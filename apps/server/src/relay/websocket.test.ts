import type { WebSocketLike } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RELAY_SUBPROTOCOL } from "./protocol.js";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    RATE_LIMIT_AUTH_POINTS: 100,
    RATE_LIMIT_AUTH_DURATION: 60,
    RATE_LIMIT_AUTH_BLOCK_DURATION: 60,
    RATE_LIMIT_SIGNUP_POINTS: 100,
    RATE_LIMIT_SIGNUP_DURATION: 60,
    RATE_LIMIT_SIGNUP_BLOCK_DURATION: 60,
    RATE_LIMIT_RPC_POINTS: 100,
    RATE_LIMIT_RPC_DURATION: 60,
    TRUST_PROXY_HOPS: undefined,
  },
}));

vi.mock("@ws-model-proxy/api/lib/cli-credential-access", () => ({
  authenticateCliWebsocketSecret: vi.fn(),
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

const { authenticateCliWebsocketSecret } = await import(
  "@ws-model-proxy/api/lib/cli-credential-access"
);
const { createRelayWebsocketMiddleware, relaySocketEvents } = await import("./websocket.js");
const { relaySessionManager } = await import("./session-manager.js");
const { WSContext } = await import("hono/ws");

const authenticateMock = vi.mocked(authenticateCliWebsocketSecret);

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
      error: "CLI websocket authentication required.",
    });
  });

  it("rejects unsupported relay protocol versions before upgrade", async () => {
    const response = await app().request("/api/cli/ws", {
      method: "GET",
      headers: websocketHeaders({
        Authorization: "Bearer wsmp_cli_secret",
        "Sec-WebSocket-Protocol": "ws-model-proxy.relay.v1",
      }),
    });

    expect(response.status).toBe(426);
    await expect(response.json()).resolves.toMatchObject({
      type: "protocol.error",
      failure: "protocol_error",
      code: "upgrade_cli",
      supportedVersions: ["2.4"],
      supportedSubprotocol: "ws-model-proxy.relay.v2",
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
      headers: websocketHeaders({ Authorization: "Bearer wsmp_cli_secret" }),
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
      headers: websocketHeaders({ Authorization: "Bearer wsmp_cli_secret" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid or revoked CLI websocket credential.",
    });
  });
});

describe("relay upgrade during shutdown", () => {
  const identity = {
    userId: "user-id",
    cliCredentialId: "cred-id",
    cliDeviceId: null,
  } as unknown as Parameters<typeof relaySocketEvents>[0];

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
      headers: websocketHeaders({ Authorization: "Bearer wsmp_cli_secret" }),
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
