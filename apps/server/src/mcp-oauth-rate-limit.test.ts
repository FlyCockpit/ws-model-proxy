import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 3 MCP OAuth rate-limit tests (unit level):
 * - allowlist EXACTNESS (listed method+path → MCP limiter; near-misses and
 *   wrong-method variants pass through to the general limiter);
 * - session-keyed consent/continue limiting with IP fallback;
 * - small form-body caps on authorize/token/consent (413, app convention);
 * - RETENTION of the installed provider's own endpoint-specific rateLimit
 *   entries (token/authorize/introspect/revoke/userinfo) under
 *   resolveMcpPlugins.
 *
 * The production ORDERING contract (the flag-on block and the general-limiter
 * exemption in the REAL registration chain, incl. %61uth spellings of all
 * nine pairs) is covered by app-order.test.ts, which mounts the REAL
 * createApp() output (L24).
 */

const grants = vi.hoisted(() => ({ findUnique: vi.fn(), create: vi.fn() }));
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
vi.mock("@ws-model-proxy/db", () => ({ default: { mcpGrant: grants } }));
vi.mock("@ws-model-proxy/auth", () => ({
  auth: { api: { getSession: vi.fn().mockResolvedValue(null) } },
}));

const mockGetConnInfo = vi.hoisted(() => vi.fn(() => ({ remote: { address: "10.0.0.1" } })));
vi.mock("@hono/node-server/conninfo", () => ({ getConnInfo: mockGetConnInfo }));

import { resolveMcpPlugins } from "../../../packages/auth/src/mcp-plugins";
import {
  isMcpOauthRateLimited,
  MCP_OAUTH_AUTHORIZE_MAX_BODY_BYTES,
  MCP_OAUTH_CONSENT_MAX_BODY_BYTES,
  MCP_OAUTH_TOKEN_MAX_BODY_BYTES,
  mcpConsentKey,
  mcpOauthBodyCap,
  mcpOauthIpKey,
  mcpOauthRateLimits,
} from "./mcp-oauth-rate-limit";

const BASE = "https://proxy.example.com";

beforeEach(() => {
  mockGetConnInfo.mockReturnValue({ remote: { address: "10.0.0.1" } });
});

describe("isMcpOauthRateLimited — exact method+path allowlist", () => {
  const cases: Array<[string, string, boolean]> = [
    ["GET", "/api/auth/oauth2/authorize", true],
    ["POST", "/api/auth/oauth2/authorize", true],
    ["POST", "/api/auth/oauth2/consent", true],
    ["POST", "/api/auth/oauth2/continue", true],
    ["POST", "/api/auth/oauth2/token", true],
    ["POST", "/api/auth/oauth2/revoke", true],
    ["GET", "/api/auth/oauth2/public-client", true],
    ["POST", "/api/auth/oauth2/public-client-prelogin", true],
    ["GET", "/api/auth/jwks", true],
    // Wrong method on a listed path → NOT MCP-handled.
    ["DELETE", "/api/auth/oauth2/authorize", false],
    ["PUT", "/api/auth/oauth2/token", false],
    ["GET", "/api/auth/oauth2/consent", false],
    ["HEAD", "/api/auth/jwks", false],
    ["POST", "/api/auth/oauth2/public-client", false],
    ["GET", "/api/auth/oauth2/public-client-prelogin", false],
    // Unlisted paths (keep the general limiter).
    ["POST", "/api/auth/oauth2/introspect", false],
    ["POST", "/api/auth/oauth2/userinfo", false],
    ["POST", "/api/auth/sign-in/email", false],
    ["POST", "/api/auth/oauth2/register", false],
    ["GET", "/api/auth/.well-known/oauth-authorization-server", false],
    // Near-miss path spellings.
    ["POST", "/api/auth/oauth2/authorize/", false],
    ["POST", "/api/auth/oauth2/authorize/extra", false],
    ["GET", "/api/auth/jwks/..", false],
  ];

  it.each(cases)("%s %s → %s", (method, path, expected) => {
    expect(isMcpOauthRateLimited(method, path)).toBe(expected);
  });

  it("method matching is case-insensitive on input but stored routes are canonical", () => {
    expect(isMcpOauthRateLimited("get", "/api/auth/jwks")).toBe(true);
  });
});

describe("mcpOauthRateLimits middleware — limiter selection and keying", () => {
  function buildApp() {
    const app = new Hono();
    app.use("/api/auth/*", mcpOauthRateLimits);
    app.all("/api/auth/*", (c) => c.text("downstream"));
    return app;
  }

  it("listed route hits the MCP OAuth limiter (limit 2) then 429s", async () => {
    const app = buildApp();
    const first = await app.request(`${BASE}/api/auth/jwks`);
    expect(first.status).toBe(200);
    expect(first.headers.get("X-RateLimit-Limit")).toBe("2");
    const second = await app.request(`${BASE}/api/auth/jwks`);
    expect(second.status).toBe(200);
    const third = await app.request(`${BASE}/api/auth/jwks`);
    expect(third.status).toBe(429);
    expect(third.headers.get("X-RateLimit-Limit")).toBe("2");
    expect(third.headers.get("Retry-After")).toBeTruthy();
  });

  it("near-miss (unlisted path) passes through untouched — no MCP headers, no 429", async () => {
    const app = buildApp();
    for (let i = 0; i < 5; i++) {
      const res = await app.request(`${BASE}/api/auth/oauth2/introspect`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
    }
  });

  it("listed path with WRONG METHOD does not consume the MCP bucket", async () => {
    const app = buildApp();
    for (let i = 0; i < 5; i++) {
      const res = await app.request(`${BASE}/api/auth/oauth2/token`, { method: "PUT" });
      expect(res.status).toBe(200);
      expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
    }
    // The real token route still gets the MCP limiter.
    const token = await app.request(`${BASE}/api/auth/oauth2/token`, { method: "POST" });
    expect(token.headers.get("X-RateLimit-Limit")).toBe("2");
  });

  it("consent limiting is session-keyed: different users get independent buckets", async () => {
    type SessionVars = { Variables: { session: { user?: { id?: string } } | null } };
    const app = new Hono<SessionVars>();
    // Session stub BEFORE the limiter — mirrors sessionMiddleware mounting.
    app.use("/api/auth/oauth2/consent", (c, next) => {
      c.set("session", { user: { id: c.req.header("x-test-user") ?? "u-anon" } });
      return next();
    });
    app.use("/api/auth/*", mcpOauthRateLimits);
    app.all("/api/auth/*", (c) => c.text("downstream"));

    const hit = (user: string) =>
      app.request(`${BASE}/api/auth/oauth2/consent`, {
        method: "POST",
        headers: { "x-test-user": user },
      });
    expect((await hit("u1")).status).toBe(200);
    expect((await hit("u1")).status).toBe(200);
    expect((await hit("u1")).status).toBe(429); // u1 exhausted
    expect((await hit("u2")).status).toBe(200); // u2 independent
  });

  it("consent limiting falls back to the IP key without a session", async () => {
    const app = buildApp();
    expect((await app.request(`${BASE}/api/auth/oauth2/consent`, { method: "POST" })).status).toBe(
      200,
    );
    expect((await app.request(`${BASE}/api/auth/oauth2/consent`, { method: "POST" })).status).toBe(
      200,
    );
    expect((await app.request(`${BASE}/api/auth/oauth2/consent`, { method: "POST" })).status).toBe(
      429,
    );
    // Different IP → fresh IP bucket.
    mockGetConnInfo.mockReturnValue({ remote: { address: "10.0.0.9" } });
    expect((await app.request(`${BASE}/api/auth/oauth2/consent`, { method: "POST" })).status).toBe(
      200,
    );
  });

  it("IP-keyed protocol bucket is per-IP", async () => {
    const app = buildApp();
    mockGetConnInfo.mockReturnValue({ remote: { address: "198.51.100.1" } });
    expect((await app.request(`${BASE}/api/auth/oauth2/token`, { method: "POST" })).status).toBe(
      200,
    );
    expect((await app.request(`${BASE}/api/auth/oauth2/token`, { method: "POST" })).status).toBe(
      200,
    );
    expect((await app.request(`${BASE}/api/auth/oauth2/token`, { method: "POST" })).status).toBe(
      429,
    );
    mockGetConnInfo.mockReturnValue({ remote: { address: "198.51.100.2" } });
    expect((await app.request(`${BASE}/api/auth/oauth2/token`, { method: "POST" })).status).toBe(
      200,
    );
  });
});

describe("key builders", () => {
  it("mcpOauthIpKey prefixes the client IP", async () => {
    mockGetConnInfo.mockReturnValue({ remote: { address: "198.51.100.7" } });
    const app = new Hono();
    app.get("/", (c) => c.text(mcpOauthIpKey(c)));
    const res = await app.request(`${BASE}/`, { headers: { "x-forwarded-for": "203.0.113.9" } });
    // Bare public socket peer: X-Forwarded-For is ignored, key is the peer.
    expect(await res.text()).toBe("mcp:oauth:ip:198.51.100.7");
  });

  it("mcpConsentKey prefers the session user id and falls back to the IP", async () => {
    type SessionVars = { Variables: { session: { user?: { id?: string } } | null } };
    const withSession = new Hono<SessionVars>();
    withSession.get("/", (c) => {
      c.set("session", { user: { id: "user-1" } });
      return c.text(mcpConsentKey(c));
    });
    const sessionRes = await withSession.request(`${BASE}/`);
    expect(await sessionRes.text()).toBe("mcp:consent:uid:user-1");

    const anonymous = new Hono<SessionVars>();
    anonymous.get("/", (c) => {
      c.set("session", null);
      return c.text(mcpConsentKey(c));
    });
    mockGetConnInfo.mockReturnValue({ remote: { address: "198.51.100.8" } });
    const anonRes = await anonymous.request(`${BASE}/`);
    expect(await anonRes.text()).toBe("mcp:consent:ip:198.51.100.8");
  });
});

describe("mcpOauthBodyCap — small form-body caps", () => {
  const FORM = "application/x-www-form-urlencoded";
  const oversized = (bytes: number) => "x".repeat(bytes);

  function buildApp() {
    const app = new Hono();
    app.use("/api/auth/oauth2/authorize", mcpOauthBodyCap(MCP_OAUTH_AUTHORIZE_MAX_BODY_BYTES));
    app.use("/api/auth/oauth2/token", mcpOauthBodyCap(MCP_OAUTH_TOKEN_MAX_BODY_BYTES));
    app.use("/api/auth/oauth2/consent", mcpOauthBodyCap(MCP_OAUTH_CONSENT_MAX_BODY_BYTES));
    app.all("/api/auth/*", (c) => c.text("downstream"));
    return app;
  }

  it("documented constants are small (16/16/32 KB)", () => {
    expect(MCP_OAUTH_AUTHORIZE_MAX_BODY_BYTES).toBe(16 * 1024);
    expect(MCP_OAUTH_TOKEN_MAX_BODY_BYTES).toBe(16 * 1024);
    expect(MCP_OAUTH_CONSENT_MAX_BODY_BYTES).toBe(32 * 1024);
  });

  it.each([
    ["authorize", MCP_OAUTH_AUTHORIZE_MAX_BODY_BYTES],
    ["token", MCP_OAUTH_TOKEN_MAX_BODY_BYTES],
    ["consent", MCP_OAUTH_CONSENT_MAX_BODY_BYTES],
  ] as const)("%s oversize → 413 with the app's standard body-cap shape", async (_name, cap) => {
    const app = buildApp();
    const res = await app.request(`${BASE}/api/auth/oauth2/${_name}`, {
      method: "POST",
      headers: { "content-type": FORM },
      body: oversized(cap + 1),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: "Request is too large. Try uploading a smaller file.",
    });
  });

  it("under-cap bodies pass through to the handler", async () => {
    const app = buildApp();
    for (const [path, cap] of [
      ["authorize", MCP_OAUTH_AUTHORIZE_MAX_BODY_BYTES],
      ["token", MCP_OAUTH_TOKEN_MAX_BODY_BYTES],
      ["consent", MCP_OAUTH_CONSENT_MAX_BODY_BYTES],
    ] as const) {
      const res = await app.request(`${BASE}/api/auth/oauth2/${path}`, {
        method: "POST",
        headers: { "content-type": FORM },
        body: "a".repeat(Math.max(1, cap - 1)),
      });
      expect(res.status, path).toBe(200);
    }
  });
});

describe("upstream endpoint-specific rate limits are retained (config probe)", () => {
  it("resolveMcpPlugins keeps the provider's plugin-level rateLimit entries", async () => {
    const memory: Record<string, Record<string, unknown>[]> = {
      user: [],
      session: [],
      account: [],
      verification: [],
      oauthAccessToken: [],
      oauthRefreshToken: [],
      oauthConsent: [],
      oauthClientAssertion: [],
      jwks: [],
      oauthResource: [],
      oauthClientResource: [],
      oauthClient: [],
    };
    const auth = betterAuth({
      baseURL: BASE,
      secret: "parity-test-secret-at-least-thirty-two-characters",
      database: memoryAdapter(memory),
      emailAndPassword: { enabled: true },
      logger: { disabled: true },
      plugins: resolveMcpPlugins({ enabled: true, baseUrl: BASE }),
    });
    const provider = auth.options.plugins.find((p) => p.id === "oauth-provider");
    expect(provider).toBeDefined();
    expect("rateLimit" in provider!).toBe(true);
    const rules = (provider as { rateLimit: Array<Record<string, unknown>> }).rateLimit;
    const matches = (path: string) =>
      rules.some(
        (rule) =>
          typeof rule.pathMatcher === "function" &&
          (rule.pathMatcher as (p: string) => boolean)(path),
      );
    // The plan's retained set: token, authorize, introspect, revoke, userinfo.
    expect(matches("/oauth2/token")).toBe(true);
    expect(matches("/oauth2/authorize")).toBe(true);
    expect(matches("/oauth2/introspect")).toBe(true);
    expect(matches("/oauth2/revoke")).toBe(true);
    expect(matches("/oauth2/userinfo")).toBe(true);
    // And the retained ceilings are the upstream defaults.
    const tokenRule = rules.find(
      (rule) =>
        typeof rule.pathMatcher === "function" &&
        (rule.pathMatcher as (p: string) => boolean)("/oauth2/token"),
    );
    expect(tokenRule).toMatchObject({ window: 60, max: 20 });
  });
});
