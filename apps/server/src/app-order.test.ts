import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PRODUCTION-REGISTRATION ORDERING CONTRACT TESTS (ledger L24, Part E pass 3;
 * env contract narrowed + configuration-consistency regression, pass 4 / L25).
 *
 * These tests mount the REAL output of `createApp()` from ./app.ts — the same
 * factory index.ts calls at boot — with only the process dependencies mocked
 * (env, Prisma via mockDeep, the shared auth instance, conninfo). NO
 * hand-built middleware chains: if the alias registration inside app.ts moves
 * below the CORS / global body-limit blocks, or the MCP OAuth flag-on block
 * drifts from the general limiter, THESE TESTS FAIL (mutation-verified).
 *
 * ENV SEAM (L25): createApp deliberately has NO env option — it reads the
 * shared `@ws-model-proxy/env/server` module env, the SAME source every
 * mounted consumer reads (the authorize guard and alias gates at
 * request/construction time; the rate-limit buckets at import time). Tests
 * control configuration the established suite way: vi.mock the env module
 * with a hoisted MUTABLE object and set `WMP_MCP_ENABLED` before each
 * createApp call (the mcp-authorize-scope-guard.test.ts / client-ip.test.ts
 * pattern). Bucket values (RATE_LIMIT_*) are never mutated: the limiters
 * capture them at import, so mutating them mid-run would recreate exactly
 * the seam inconsistency the L25 regression below exists to detect.
 *
 * The pure unit tests for the matcher/redaction helpers and the forwarder
 * live in mcp-discovery.test.ts / mcp-oauth-rate-limit.test.ts /
 * request-log-redaction.test.ts and stay as-is.
 */

// Mutable env mock — the SINGLE shared env source for the factory AND every
// mounted consumer (L25 narrowed contract; see the file header). Only the
// flag is mutated per build; bucket values stay at their hoisted values.
const envMock = vi.hoisted(() => ({
  NODE_ENV: "test",
  WMP_MCP_ENABLED: true,
  BETTER_AUTH_URL: "https://proxy.example.com",
  BETTER_AUTH_SECRET: "contract-test-secret-at-least-thirty-two-characters",
  // CORS_ORIGIN is SET so the cors() middleware is mounted: the OPTIONS probe
  // is only meaningful if a misplaced alias would let CORS answer 204.
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

// Mock @ws-model-proxy/db so importing the full appRouter graph never
// touches Postgres (same pattern as packages/api/src/routers/index.test.ts).
vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

// @ws-model-proxy/auth builds the Better-Auth instance at import time — stub
// it; the contract tests inject a REAL memory-adapter instance into createApp.
vi.mock("@ws-model-proxy/auth", () => ({
  auth: { api: { getSession: vi.fn().mockResolvedValue(null) } },
}));

// @ws-model-proxy/mailer would open SMTP — stub the surface the graph uses.
// Mocked by SOURCE PATH: the specifier is not a direct dependency of
// apps/server (pnpm strict node_modules), so a specifier-keyed mock never
// matches the id that packages/api resolves.
vi.mock("../../../packages/mailer/src/index", () => ({
  sendEmail: vi.fn(),
  renderInviteUser: vi.fn(() => ({ subject: "", html: "" })),
  verifyTransport: vi.fn(async () => false),
}));

const mockGetConnInfo = vi.hoisted(() => vi.fn(() => ({ remote: { address: "10.0.0.1" } })));
vi.mock("@hono/node-server/conninfo", () => ({ getConnInfo: mockGetConnInfo }));

import { resolveMcpPlugins } from "../../../packages/auth/src/mcp-plugins";
import { createApp } from "./app";
import { MCP_WELL_KNOWN_PATHS } from "./mcp-discovery";
import { MCP_OAUTH_RATE_LIMITED_ROUTES } from "./mcp-oauth-route-match";

const BASE = "https://proxy.example.com";
const ISSUER = `${BASE}/api/auth`;
const CANONICAL = `${BASE}/mcp`;
/**
 * Direct Host header for GET requests through the alias forwarders —
 * hand-built undici Requests carry none, and the canonical-authority
 * boundary (Part F pass 2) requires one, as real wire requests always do.
 */
const HOST = { host: "proxy.example.com" } as const;
const OVERSIZED_BODY = "x".repeat(11 * 1024 * 1024); // > the global 10 MB cap
const CORS_HEADERS = {
  origin: "https://app.example.com",
  "access-control-request-method": "GET",
};

/** Real installed handler + memory adapter (parity-test pattern). */
const memoryAuth = betterAuth({
  baseURL: BASE,
  secret: "contract-test-secret-at-least-thirty-two-characters",
  database: memoryAdapter({
    oauthAccessToken: [],
    oauthRefreshToken: [],
    oauthConsent: [],
    oauthClientAssertion: [],
    jwks: [],
    oauthResource: [],
    oauthClientResource: [],
    user: [],
    session: [],
    account: [],
    verification: [],
    oauthClient: [],
  }),
  emailAndPassword: { enabled: true },
  logger: { disabled: true },
  plugins: resolveMcpPlugins({ enabled: true, baseUrl: BASE }),
});

/** The REAL production app with the MCP flag toggled per build. */
async function buildApp(mcpEnabled: boolean) {
  // Flip the SHARED env module mock BEFORE construction so the factory's
  // alias gates, the flag-on MCP OAuth block, the general-limiter exemption,
  // AND the request-time authorize guard all read the same value (L25).
  envMock.WMP_MCP_ENABLED = mcpEnabled;
  const { app } = await createApp({ auth: memoryAuth });
  return app;
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Silence the production request-log wrapper (and capture for redaction
  // assertions where needed).
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  mockGetConnInfo.mockReturnValue({ remote: { address: "10.0.0.1" } });
});

afterEach(() => {
  logSpy.mockRestore();
});

const ROOT_ALIASES = MCP_WELL_KNOWN_PATHS.filter((p) => !p.startsWith("/api/auth"));

describe("createApp registration contract — discovery gates own every method (L24)", () => {
  it("flag ON: OPTIONS on every alias → 405 Allow: GET, HEAD (CORS never answers 204)", async () => {
    const app = await buildApp(true);
    for (const alias of MCP_WELL_KNOWN_PATHS) {
      const res = await app.request(`${BASE}${alias}`, {
        method: "OPTIONS",
        headers: CORS_HEADERS,
      });
      expect(res.status, alias).toBe(405);
      expect(res.headers.get("allow"), alias).toBe("GET, HEAD");
    }
  });

  it("flag OFF: OPTIONS on every alias → 404 (CORS never answers 204)", async () => {
    const app = await buildApp(false);
    for (const alias of MCP_WELL_KNOWN_PATHS) {
      const res = await app.request(`${BASE}${alias}`, {
        method: "OPTIONS",
        headers: CORS_HEADERS,
      });
      expect(res.status, alias).toBe(404);
    }
  });

  it("flag ON: oversized POST on every alias → 405 Allow (body limiter never answers 413)", async () => {
    const app = await buildApp(true);
    for (const alias of MCP_WELL_KNOWN_PATHS) {
      const res = await app.request(`${BASE}${alias}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: OVERSIZED_BODY,
      });
      expect(res.status, alias).toBe(405);
      expect(res.headers.get("allow"), alias).toBe("GET, HEAD");
    }
  });

  it("flag OFF: oversized POST on every alias → 404 (body limiter never answers 413)", async () => {
    const app = await buildApp(false);
    for (const alias of MCP_WELL_KNOWN_PATHS) {
      const res = await app.request(`${BASE}${alias}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: OVERSIZED_BODY,
      });
      expect(res.status, alias).toBe(404);
    }
  });

  it("controls: CORS preflight (204) and the global 10 MB body limiter (413) still answer OFF the alias paths", async () => {
    const app = await buildApp(true);
    const preflight = await app.request(`${BASE}/some/other/path`, {
      method: "OPTIONS",
      headers: CORS_HEADERS,
    });
    expect(preflight.status).toBe(204);
    const oversize = await app.request(`${BASE}/some/other/path`, {
      method: "POST",
      body: OVERSIZED_BODY,
    });
    expect(oversize.status).toBe(413);
  });

  it("GET metadata parity with the installed handler still intact (all four aliases)", async () => {
    const app = await buildApp(true);
    for (const alias of [
      "/.well-known/oauth-authorization-server/api/auth",
      "/api/auth/.well-known/oauth-authorization-server",
    ] as const) {
      const res = await app.request(`${BASE}${alias}`, { headers: HOST });
      expect(res.status, alias).toBe(200);
      const doc = (await res.json()) as Record<string, unknown>;
      expect(doc.issuer, alias).toBe(ISSUER);
      expect(doc.token_endpoint, alias).toBe(`${ISSUER}/oauth2/token`);
      expect(doc.registration_endpoint, alias).toBeUndefined();
    }
    for (const alias of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ] as const) {
      const res = await app.request(`${BASE}${alias}`, { headers: HOST });
      expect(res.status, alias).toBe(200);
      const doc = (await res.json()) as Record<string, unknown>;
      expect(doc.resource, alias).toBe(CANONICAL);
      expect(doc.authorization_servers, alias).toEqual([ISSUER]);
    }
  });
});

describe("createApp registration contract — MCP OAuth limiter selection (L24)", () => {
  it("flag ON: `%61uth`-encoded spellings of ALL NINE pairs keep the GENERAL limiter (never the MCP buckets)", async () => {
    const app = await buildApp(true);
    for (const [method, path] of MCP_OAUTH_RATE_LIMITED_ROUTES) {
      const encoded = path.replace("/api/auth/", "/api/%61uth/");
      // Three hits: the MCP buckets hold 2 points, so a third unconstrained
      // request proves no MCP consumption; every request must carry the
      // GENERAL authLimiter headers (limit 500 in the env mock).
      for (let i = 0; i < 3; i++) {
        const res = await app.request(`${BASE}${encoded}`, {
          method,
          headers:
            method === "GET" ? undefined : { "content-type": "application/x-www-form-urlencoded" },
          body: method === "GET" ? undefined : "a=1",
        });
        expect(res.status, `${method} ${encoded} #${i}`).not.toBe(429);
        expect(res.headers.get("x-ratelimit-limit"), `${method} ${encoded}`).toBe("500");
      }
    }
  });

  it("control: the UNENCODED GET /api/auth/jwks pair is exempt from the general limiter and served by the MCP bucket (limit 2)", async () => {
    const app = await buildApp(true);
    const res = await app.request(`${BASE}/api/auth/jwks`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ratelimit-limit")).toBe("2");
  });
});

describe("createApp registration contract — root-alias request-log redaction (L24)", () => {
  it.each([
    ["flag ON (metadata served)", true, 200],
    ["flag OFF (reserved 404)", false, 404],
  ])("%s: query with OAuth values never reaches a log line", async (_label, flag, status) => {
    const rootAlias = ROOT_ALIASES[0];
    if (!rootAlias) throw new Error("root alias missing from MCP_WELL_KNOWN_PATHS");
    const app = await buildApp(flag);
    const QUERY = `?state=st-SECRET-state&code_challenge=cc-SECRET-challenge&code=SECRET-code`;
    const res = await app.request(`${BASE}${rootAlias}${QUERY}`, { headers: HOST });
    expect(res.status).toBe(status);
    const lines: string[] = logSpy.mock.calls.flat().map(String);
    expect(lines.some((l) => l.includes(rootAlias))).toBe(true);
    for (const line of lines) {
      expect(line).not.toContain("?");
      expect(line).not.toContain("state=");
      expect(line).not.toContain("code_challenge");
      expect(line).not.toContain("SECRET");
    }
  });

  it.each([
    ["flag ON", true, "/es-MX/mcp-login"],
    ["flag OFF (gate 404 — the log wrapper still runs first)", false, "/es-MX/mcp-login"],
    ["flag ON", true, "/es-MX/mcp-consent"],
    ["flag OFF (gate 404 — the log wrapper still runs first)", false, "/es-MX/mcp-consent"],
  ])(
    "MCP login/consent PAGES: non-default-locale signed query never reaches a log line (%s %s)",
    async (_label, flag, page) => {
      // Part H pass 2 (R83/R84 F2): /es-MX/mcp-login and /es-MX/mcp-consent
      // carry the SIGNED OAuth query; the request-log wrapper runs BEFORE
      // the availability gate, so the query is stripped in BOTH flag states.
      const app = await buildApp(flag);
      const QUERY = `?client_id=c-1&state=st-SECRET-state&code_challenge=cc-SECRET-challenge&sig=SECRET-sig&ba_param=client_id&ba_param=scope`;
      const res = await app.request(`${BASE}${page}${QUERY}`, { headers: HOST });
      // flag-on reaches the SSR handler (any status is fine for the log
      // assertion); flag-off is the gate's 404.
      if (!flag) expect(res.status).toBe(404);
      const lines: string[] = logSpy.mock.calls.flat().map(String);
      expect(lines.some((l) => l.includes(page))).toBe(true);
      for (const line of lines) {
        expect(line).not.toContain("?");
        expect(line).not.toContain("state=");
        expect(line).not.toContain("code_challenge");
        expect(line).not.toContain("sig=");
        expect(line).not.toContain("SECRET");
      }
    },
  );
  it("the FOURTH alias (under /api/auth) logs the TRUNCATED auth path — never the query", async () => {
    const app = await buildApp(true);
    const fourth = "/api/auth/.well-known/oauth-authorization-server";
    const res = await app.request(`${BASE}${fourth}?state=st-SECRET-state`, { headers: HOST });
    expect(res.status).toBe(200);
    const lines: string[] = logSpy.mock.calls.flat().map(String);
    expect(lines.some((l) => l.includes("/api/auth/.well-known"))).toBe(true);
    for (const line of lines) {
      expect(line).not.toContain("?");
      expect(line).not.toContain("state=");
      expect(line).not.toContain("SECRET");
    }
  });
});

describe("createApp configuration consistency — ONE shared env source for every consumer (L25)", () => {
  // R49/R50 convergent finding: per-construction env overrides could never
  // reach the import-time consumers (limiter buckets) or the request-time
  // readers (authorize guard), so a factory override could contradict the
  // module env (probe: override MCP off + module flag on → guard still 400;
  // overridden RATE_LIMIT_MCP_* silently ignored). The contract is NARROWED:
  // createApp reads the shared env module, and these regressions prove the
  // factory, the authorize guard, BOTH MCP OAuth buckets, and the alias
  // gates all consult the SAME mocked env object in a given mounted app —
  // any future seam reintroduction (one consumer reading a different env
  // than another) makes these assertions disagree and FAIL.

  it("flag ON: guard active, alias gates on, and BOTH MCP buckets match the mocked RATE_LIMIT_MCP_* values in one mounted app", async () => {
    const app = await buildApp(true);

    // Alias gates: flag-on GET forwards to the installed handler (served).
    const metadata = await app.request(`${BASE}/.well-known/oauth-protected-resource`, {
      headers: HOST,
    });
    expect(metadata.status).toBe(200);

    // Authorize guard + MCP protocol bucket in ONE request: the guard's
    // local invalid_scope 400 (flag read at request time from the shared
    // mock) AND the protocol bucket's mocked RATE_LIMIT_MCP_POINTS (2,
    // captured at import from the SAME mock).
    const authorize = await app.request(`${BASE}/api/auth/oauth2/authorize`);
    expect(authorize.status).toBe(400);
    expect(await authorize.json()).toMatchObject({ error: "invalid_scope" });
    expect(authorize.headers.get("x-ratelimit-limit")).toBe("2");

    // MCP consent/continue bucket: mocked RATE_LIMIT_MCP_CONSENT_POINTS (2).
    const consent = await app.request(`${BASE}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "a=1",
    });
    expect(consent.headers.get("x-ratelimit-limit")).toBe("2");
  });

  it("flag OFF: guard inactive, alias gates off, and BOTH paths answer from the GENERAL bucket in one mounted app", async () => {
    const app = await buildApp(false);

    // Alias gates: flag-off reserved 404 for every method (OPTIONS probe —
    // the shape CORS would answer 204 on if the gate disagreed).
    const metadata = await app.request(`${BASE}/.well-known/oauth-protected-resource`, {
      method: "OPTIONS",
      headers: CORS_HEADERS,
    });
    expect(metadata.status).toBe(404);

    // Guard inactive: no local invalid_scope rejection, and the request is
    // retained by the GENERAL limiter (mocked RATE_LIMIT_AUTH_POINTS 500 —
    // flag-off does not honor the MCP exemption).
    // Guard inactive: no local invalid_scope 400 — the request falls through
    // to the downstream provider, which answers its own redirected protocol
    // error (302, parity-pinned installed behavior) — AND the request is
    // retained by the GENERAL limiter (mocked RATE_LIMIT_AUTH_POINTS 500;
    // flag-off does not honor the MCP exemption).
    const authorize = await app.request(`${BASE}/api/auth/oauth2/authorize`);
    expect(authorize.status).toBe(302);
    expect(authorize.headers.get("x-ratelimit-limit")).toBe("500");

    // MCP buckets NOT consulted flag-off: jwks (protocol) and consent both
    // answer from the general bucket instead of the MCP values (2).
    const jwks = await app.request(`${BASE}/api/auth/jwks`);
    expect(jwks.headers.get("x-ratelimit-limit")).toBe("500");
    const consent = await app.request(`${BASE}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "a=1",
    });
    expect(consent.headers.get("x-ratelimit-limit")).toBe("500");
  });
});
