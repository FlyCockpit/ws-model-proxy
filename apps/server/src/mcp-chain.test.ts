import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /mcp CHAIN-ORDER contract tests (MCP plan Phase 4 items 6-7) — the REAL
 * output of `createApp()` with only process dependencies mocked (the
 * app-order.test.ts pattern), plus a REAL memory-adapter Better Auth
 * instance injected as `mcpAuth` so the upstream `requireMcpAuth` wrapper
 * can resolve `$context` and produce its genuine no-token 401 challenge.
 *
 * Pins, against the mounted production app:
 * - flag-off: /mcp → 404 for EVERY method (feature gate owns the path);
 * - flag-on: method gate BEFORE auth (GET with a bad token → 405, not 401);
 * - flag-on: the MCP 1 MB body cap answers BEFORE auth (413, not 401) and
 *   before the global 10 MB limiter (a 1.5 MB body never reaches it);
 * - flag-on: the mcp:ip: limiter runs BEFORE the body cap (an exhausted IP
 *   bucket answers 429 to an oversized body, not 413);
 * - flag-on: POST without a credential → the upstream 401 challenge with
 *   the RFC 9728 resource_metadata pointer.
 *
 * Bucket hygiene: the IP bucket is a module singleton — every test uses a
 * UNIQUE client IP so exhaustion assertions cannot leak across tests.
 */

const envMock = vi.hoisted(() => ({
  NODE_ENV: "test",
  WMP_MCP_ENABLED: true,
  BETTER_AUTH_URL: "https://proxy.example.com",
  BETTER_AUTH_SECRET: "chain-test-secret-at-least-thirty-two-characters",
  CORS_ORIGIN: "https://app.example.com",
  RATE_LIMIT_AUTH_POINTS: 500,
  RATE_LIMIT_AUTH_DURATION: 60,
  RATE_LIMIT_AUTH_BLOCK_DURATION: 0,
  RATE_LIMIT_SIGNUP_POINTS: 3,
  RATE_LIMIT_SIGNUP_DURATION: 3600,
  RATE_LIMIT_SIGNUP_BLOCK_DURATION: 3600,
  RATE_LIMIT_RPC_POINTS: 1000,
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
  MEDIA_MAX_UPLOAD_BYTES: 5 * 1024 * 1024,
  MODEL_API_TRANSCRIPTION_MAX_MULTIPART_BYTES: 1024 * 1024,
  MODEL_API_GLOBAL_CAPACITY_ENABLED: false,
  WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: false,
  SSR_CACHE_TTL_SECONDS: 0,
}));
vi.mock("@ws-model-proxy/env/server", () => ({ env: envMock }));

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

vi.mock("@ws-model-proxy/auth", () => ({
  auth: { api: { getSession: vi.fn().mockResolvedValue(null) } },
}));

vi.mock("../../../packages/mailer/src/index", () => ({
  sendEmail: vi.fn(),
  renderInviteUser: vi.fn(() => ({ subject: "", html: "" })),
  verifyTransport: vi.fn(async () => false),
}));

const mockGetConnInfo = vi.hoisted(() => vi.fn(() => ({ remote: { address: "10.0.0.1" } })));
vi.mock("@hono/node-server/conninfo", () => ({ getConnInfo: mockGetConnInfo }));

import { createApp } from "./app";

const BASE = "https://proxy.example.com";
const MCP = `${BASE}/mcp`;
const OVER_1MB = 1.5 * 1024 * 1024; // over the MCP cap, under the global 10 MB
/**
 * Hand-constructed undici Requests carry NO host header; real wire requests
 * always do. Canonical requests must pass the boundary, so set it
 * explicitly (hostile tests set their own).
 */
const HOST = { host: "proxy.example.com" } as const;

/** Real installed handler + memory adapter (no MCP plugins needed for the
 *  no-token 401 path — only a resolvable baseURL/$context). */
const memoryAuth = betterAuth({
  baseURL: BASE,
  secret: "chain-test-secret-at-least-thirty-two-characters",
  database: memoryAdapter({
    user: [],
    session: [],
    account: [],
    verification: [],
  }),
  emailAndPassword: { enabled: true },
  logger: { disabled: true },
});

async function buildApp(mcpEnabled: boolean) {
  envMock.WMP_MCP_ENABLED = mcpEnabled;
  const { app } = await createApp({ auth: memoryAuth, mcpAuth: memoryAuth });
  return app;
}

let logSpy: ReturnType<typeof vi.spyOn>;
let testCounter = 0;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Unique IP per test: the mcp:ip: bucket is a module singleton.
  testCounter += 1;
  mockGetConnInfo.mockReturnValue({ remote: { address: `198.51.100.${testCounter}` } });
});

afterEach(() => {
  logSpy.mockRestore();
  vi.restoreAllMocks();
});

describe("createApp /mcp chain — feature gate owns every method", () => {
  it("flag OFF: 404 for every method, including oversized POST", async () => {
    const app = await buildApp(false);
    for (const method of ["GET", "POST", "PUT", "DELETE", "OPTIONS"] as const) {
      const res = await app.request(MCP, {
        method,
        ...(method === "POST" || method === "PUT"
          ? {
              headers: { "content-type": "application/json" },
              body: method === "POST" ? "x".repeat(OVER_1MB) : "",
            }
          : {}),
      });
      expect(res.status, method).toBe(404);
    }
  });
});

describe("createApp /mcp chain — order pins (flag on)", () => {
  it("method gate BEFORE auth: GET with a bad Bearer token → 405 Allow: POST, not 401", async () => {
    const app = await buildApp(true);
    const res = await app.request(MCP, {
      method: "GET",
      headers: { authorization: "Bearer definitely-not-a-valid-jwt" },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it.each(["PUT", "DELETE", "OPTIONS", "HEAD"] as const)("%s → 405 Allow: POST", async (method) => {
    const app = await buildApp(true);
    const res = await app.request(MCP, { method });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("body cap BEFORE auth: 1.5 MB POST without a token → 413 (the MCP 1 MB cap, not the global 10 MB, not a 401)", async () => {
    const app = await buildApp(true);
    const res = await app.request(MCP, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(OVER_1MB),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: "Request is too large. Try uploading a smaller file.",
    });
  });

  it("IP limiter BEFORE body cap: exhausted mcp:ip: bucket answers 429 to an oversized body, not 413", async () => {
    const app = await buildApp(true);
    // Exhaust the bucket (RATE_LIMIT_MCP_POINTS = 2 in the env mock).
    for (let i = 0; i < 2; i++) {
      const warm = await app.request(MCP, {
        method: "POST",
        headers: { "content-type": "application/json", ...HOST },
        body: "{}",
      });
      expect(warm.status, JSON.stringify(vi.mocked(console.error).mock.calls)).toBe(401); // upstream no-token challenge
      expect(warm.headers.get("x-ratelimit-limit")).toBe("2");
    }
    const res = await app.request(MCP, {
      method: "POST",
      headers: { "content-type": "application/json", ...HOST },
      body: "x".repeat(OVER_1MB),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });

  it("POST without a credential → upstream 401 challenge with RFC 9728 resource_metadata", async () => {
    const app = await buildApp(true);
    const res = await app.request(MCP, {
      method: "POST",
      headers: { "content-type": "application/json", ...HOST },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
    });
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain("Bearer");
    expect(challenge).toContain(
      'resource_metadata="https://proxy.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("POST with a malformed Authorization header → upstream 401 (never a 500)", async () => {
    const app = await buildApp(true);
    const res = await app.request(MCP, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "NotBearer garbage", ...HOST },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
    });
    expect([401, 403]).toContain(res.status);
  });

  it("POST with a VALID session cookie but NO Authorization header → 401 challenge (never cookie-authenticated)", async () => {
    // Invariant 3: /mcp is a Bearer/DPoP surface ONLY. A browser session
    // cookie must never authenticate an MCP exchange — the upstream
    // requireMcpAuth wrapper reads the Authorization header, so a
    // cookie-only request is indistinguishable from a no-credential one and
    // must get the same 401 challenge (never 200, never a session-flavored
    // response). Drives a REAL signUpEmail session on the injected
    // memory-adapter instance.
    const app = await buildApp(true);
    const signup = await memoryAuth.api.signUpEmail({
      body: {
        name: "Cookie Only",
        email: "cookie-only@example.test",
        password: "chain-test-password-123",
      },
      asResponse: true,
    });
    expect(signup.status).toBe(200);
    const cookie = signup.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
    expect(cookie).toContain("better-auth.session_token");
    const res = await app.request(MCP, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, ...HOST },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
    });
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain("Bearer");
    expect(challenge).toContain(
      'resource_metadata="https://proxy.example.com/.well-known/oauth-protected-resource/mcp"',
    );
    const body = (await res.json()) as { jsonrpc?: string; error?: { code?: number } };
    expect(body.error?.code).toBe(-32000); // the no-credential JSON-RPC challenge body
  });
});

describe("createApp /mcp chain — canonical-authority boundary (F1, invariant 2)", () => {
  it("hostile Host → static 400, NEVER the upstream verifier (no 200/no-token 401)", async () => {
    const app = await buildApp(true);
    const res = await app.request("https://proxy.example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", host: "evil.example.com" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("hostile Origin → static 400 before verification", async () => {
    const app = await buildApp(true);
    const res = await app.request(MCP, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example", ...HOST },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
    });
    expect(res.status).toBe(400);
  });

  it("method gate STILL precedes the boundary: GET with a hostile Host → 405, not 400", async () => {
    const app = await buildApp(true);
    const res = await app.request("https://evil.example.com/mcp", { method: "GET" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("flag-off gate STILL precedes the boundary: hostile-Host POST → 404, not 400", async () => {
    const app = await buildApp(false);
    const res = await app.request("https://evil.example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("spoofed x-forwarded-host on the canonical direct Host is ignored → upstream 401 challenge", async () => {
    const app = await buildApp(true);
    const res = await app.request(MCP, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-host": "evil.example.com",
        "x-forwarded-proto": "https",
        ...HOST,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
    });
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain("resource_metadata");
  });

  it("absent Origin (native client) passes the boundary → upstream 401 challenge", async () => {
    const app = await buildApp(true);
    const res = await app.request(MCP, {
      method: "POST",
      headers: { "content-type": "application/json", ...HOST },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it.each(["https://proxy.example.com", "https://app.example.com"] as const)(
    "allowed Origin %s passes the boundary (web + server origin both admitted)",
    async (origin) => {
      const app = await buildApp(true);
      const res = await app.request(MCP, {
        method: "POST",
        headers: { "content-type": "application/json", origin, ...HOST },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
      });
      // Boundary passed — the upstream verifier answers (no credential).
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
    },
  );

  it("HTTP ingress with the canonical Host passes the boundary (canonical clone carries the configured https origin for DPoP htu)", async () => {
    const app = await buildApp(true);
    // TLS terminates upstream; this hop is plain HTTP but the direct Host is
    // the canonical public host. The boundary must not demand HTTPS from the
    // socket — the canonical scheme is re-derived from configuration.
    const res = await app.request("http://proxy.example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...HOST },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      "https://proxy.example.com/.well-known/oauth-protected-resource/mcp",
    );
  });

  it("HTTP localhost dev: configured http origin passes the boundary", async () => {
    // Local dev runs plain HTTP against a localhost BETTER_AUTH_URL — the
    // boundary must not demand HTTPS-only locally. (CORS_ORIGIN stays set to
    // the app origin: the allowed set is { web origin, server origin }.)
    const previousUrl = envMock.BETTER_AUTH_URL;
    envMock.BETTER_AUTH_URL = "http://localhost:3000";
    try {
      const localAuth = betterAuth({
        baseURL: "http://localhost:3000",
        secret: "chain-test-secret-at-least-thirty-two-characters",
        database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
        emailAndPassword: { enabled: true },
        logger: { disabled: true },
      });
      const { app } = await createApp({ auth: localAuth, mcpAuth: localAuth });
      const res = await app.request("http://localhost:3000/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", host: "localhost:3000" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
      });
      expect(res.status).toBe(401); // boundary passed; upstream wants a credential
      const hostile = await app.request("http://localhost:3000/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://evil.example",
          host: "localhost:3000",
        },
        body: "{}",
      });
      expect(hostile.status).toBe(400); // boundary still rejects hostile Origin locally
    } finally {
      envMock.BETTER_AUTH_URL = previousUrl;
    }
  });
});

describe("createApp /mcp chain — request-log query redaction (L20 reopen, F2)", () => {
  const QUERY = "?access_token=st-SECRET-access&state=st-SECRET-state";

  it.each([
    ["flag ON (rejected upstream 401)", true, 401],
    ["flag OFF (feature-gate 404)", false, 404],
  ])("%s: no query sentinel reaches ANY captured log line", async (_label, flag, status) => {
    const app = await buildApp(flag);
    const res = await app.request(`${MCP}${QUERY}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...HOST },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
    });
    expect(res.status).toBe(status);
    const lines: string[] = logSpy.mock.calls.flat().map(String);
    expect(lines.some((l) => l.includes("/mcp"))).toBe(true);
    for (const line of lines) {
      expect(line).not.toContain("st-SECRET-access");
      expect(line).not.toContain("st-SECRET-state");
      expect(line).not.toContain("access_token");
    }
  });
});
