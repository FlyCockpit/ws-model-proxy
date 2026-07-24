import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("../rate-limit.js", () => ({
  authLimiter: {},
  createRateLimiterMiddleware: () => async (_context: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

const { authenticateCliWebsocketSecret } = await import(
  "@ws-model-proxy/api/lib/cli-credential-access"
);
const { createRelayWebsocketMiddleware } = await import("./websocket.js");

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
