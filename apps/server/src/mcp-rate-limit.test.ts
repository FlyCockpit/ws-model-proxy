import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 3 item 3 — the /mcp chain PIECES (mcp-rate-limit.ts). Nothing here
 * is mounted in production (Phase 4 mounts the chain); these tests pin the
 * pieces' contracts so mounting cannot silently change them.
 */

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    WMP_MCP_ENABLED: true,
    BETTER_AUTH_URL: "https://proxy.example.com",
    BETTER_AUTH_SECRET: "parity-test-secret-at-least-thirty-two-characters",
    CORS_ORIGIN: undefined,
    RATE_LIMIT_AUTH_POINTS: 10,
    RATE_LIMIT_AUTH_DURATION: 60,
    RATE_LIMIT_AUTH_BLOCK_DURATION: 900,
    RATE_LIMIT_SIGNUP_POINTS: 3,
    RATE_LIMIT_SIGNUP_DURATION: 3600,
    RATE_LIMIT_SIGNUP_BLOCK_DURATION: 3600,
    RATE_LIMIT_RPC_POINTS: 100,
    RATE_LIMIT_RPC_DURATION: 60,
    RATE_LIMIT_EMAIL_RECIPIENT_POINTS: 3,
    RATE_LIMIT_EMAIL_RECIPIENT_DURATION: 3600,
    RATE_LIMIT_EMAIL_RECIPIENT_BLOCK_DURATION: 0,
    RATE_LIMIT_SIGNUP_RECIPIENT_POINTS: 6,
    RATE_LIMIT_MCP_POINTS: 2,
    RATE_LIMIT_MCP_DURATION: 60,
    RATE_LIMIT_MCP_CONSENT_POINTS: 2,
    RATE_LIMIT_MCP_CONSENT_DURATION: 60,
    TRUST_PROXY_HOPS: undefined,
  },
}));

const mockGetConnInfo = vi.hoisted(() => vi.fn(() => ({ remote: { address: "10.0.0.1" } })));
vi.mock("@hono/node-server/conninfo", () => ({ getConnInfo: mockGetConnInfo }));
vi.mock("@ws-model-proxy/auth", () => ({
  auth: { api: { getSession: vi.fn().mockResolvedValue(null) } },
}));

import {
  createMcpFeatureGate,
  MCP_ENDPOINT_PATH,
  MCP_IDENTITY_KEY_PREFIX,
  MCP_IP_KEY_PREFIX,
  MCP_MAX_REQUEST_BODY_BYTES,
  mcpBodyCap,
  mcpIdentityKey,
  mcpIdentityQuotaLimiter,
  mcpIpKey,
  mcpIpLimiter,
  mcpMethodGate,
} from "./mcp-rate-limit";

const BASE = "https://proxy.example.com";

beforeEach(() => {
  mockGetConnInfo.mockReturnValue({ remote: { address: "10.0.0.1" } });
});

describe("mcpMethodGate — POST-only method gate (runs before auth)", () => {
  function buildApp() {
    const app = new Hono();
    app.use(MCP_ENDPOINT_PATH, mcpMethodGate);
    app.all(MCP_ENDPOINT_PATH, (c) => c.text("through"));
    return app;
  }

  it("POST passes through", async () => {
    const res = await buildApp().request(`${BASE}${MCP_ENDPOINT_PATH}`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("through");
  });

  it.each(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"] as const)(
    "%s → 405 with Allow: POST",
    async (method) => {
      const res = await buildApp().request(`${BASE}${MCP_ENDPOINT_PATH}`, { method });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    },
  );
});

describe("createMcpFeatureGate — flag-off 404 for every method", () => {
  it("disabled → 404 on every method (path reserved, handler never reached)", async () => {
    let handlerReached = false;
    const app = new Hono();
    app.use(MCP_ENDPOINT_PATH, createMcpFeatureGate({ enabled: false }));
    app.all(MCP_ENDPOINT_PATH, (c) => {
      handlerReached = true;
      return c.text("through");
    });
    for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE"] as const) {
      const res = await app.request(`${BASE}${MCP_ENDPOINT_PATH}`, { method });
      expect(res.status, method).toBe(404);
    }
    expect(handlerReached).toBe(false);
  });

  it("enabled → passes through", async () => {
    const app = new Hono();
    app.use(MCP_ENDPOINT_PATH, createMcpFeatureGate({ enabled: true }));
    app.all(MCP_ENDPOINT_PATH, (c) => c.text("through"));
    const res = await app.request(`${BASE}${MCP_ENDPOINT_PATH}`, { method: "POST" });
    expect(res.status).toBe(200);
  });
});

describe("key builders and prefixes", () => {
  it("mcpIpKey prefixes the connection IP (PRE-auth: never token-derived)", async () => {
    mockGetConnInfo.mockReturnValue({ remote: { address: "198.51.100.20" } });
    const app = new Hono();
    app.get("/", (c) => c.text(mcpIpKey(c)));
    const res = await app.request(`${BASE}/`, {
      headers: { authorization: "Bearer totally-attacker-chosen" },
    });
    expect(await res.text()).toBe(`${MCP_IP_KEY_PREFIX}198.51.100.20`);
  });

  it("mcpIdentityKey is built from verified sub + client_id claims only", () => {
    expect(mcpIdentityKey("user-1", "client-a")).toBe(`${MCP_IDENTITY_KEY_PREFIX}user-1:client-a`);
    expect(mcpIdentityKey("user-1", "client-b")).not.toBe(mcpIdentityKey("user-1", "client-a"));
    expect(mcpIdentityKey("user-2", "client-a")).not.toBe(mcpIdentityKey("user-1", "client-a"));
  });

  it("the module exposes NO key builder that accepts token bytes (structural bound)", () => {
    // mcpIpKey takes a Hono Context (IP only); mcpIdentityKey takes verified
    // (sub, clientId) strings. Neither accepts a token or token digest —
    // pinned by their signatures being the only exported key builders.
    expect(mcpIpKey.length).toBe(1);
    expect(mcpIdentityKey.length).toBe(2);
  });

  it("identity buckets are independent per (sub, client_id) pair", async () => {
    await mcpIdentityQuotaLimiter.consume(mcpIdentityKey("u1", "c1"), 1);
    // Exhaust u1/c1 (points = 2 in the mocked env).
    await mcpIdentityQuotaLimiter.consume(mcpIdentityKey("u1", "c1"), 1);
    await expect(
      mcpIdentityQuotaLimiter.consume(mcpIdentityKey("u1", "c1"), 1),
    ).rejects.toMatchObject({ msBeforeNext: expect.any(Number) });
    await expect(
      mcpIdentityQuotaLimiter.consume(mcpIdentityKey("u1", "c2"), 1),
    ).resolves.toMatchObject({ remainingPoints: expect.any(Number) });
    await expect(
      mcpIdentityQuotaLimiter.consume(mcpIdentityKey("u2", "c1"), 1),
    ).resolves.toMatchObject({ remainingPoints: expect.any(Number) });
  });

  it("the pre-auth IP limiter is a distinct key domain from the identity quota", () => {
    expect(mcpIpLimiter.keyPrefix).toBe(MCP_IP_KEY_PREFIX);
    expect(mcpIdentityQuotaLimiter.keyPrefix).toBe(MCP_IDENTITY_KEY_PREFIX);
    expect(mcpIpLimiter.keyPrefix).not.toBe(mcpIdentityQuotaLimiter.keyPrefix);
  });
});

describe("mcpBodyCap", () => {
  it("documented cap is 1 MB; oversize POST → 413 with the app convention", async () => {
    expect(MCP_MAX_REQUEST_BODY_BYTES).toBe(1024 * 1024);
    const app = new Hono();
    app.use(MCP_ENDPOINT_PATH, mcpBodyCap);
    app.post(MCP_ENDPOINT_PATH, (c) => c.text("through"));
    const res = await app.request(`${BASE}${MCP_ENDPOINT_PATH}`, {
      method: "POST",
      body: "x".repeat(MCP_MAX_REQUEST_BODY_BYTES + 1),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: "Request is too large. Try uploading a smaller file.",
    });
  });
});
