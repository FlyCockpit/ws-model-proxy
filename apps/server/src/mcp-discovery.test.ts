import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 3 discovery parity tests: the four well-known alias paths must be
 * served by the REAL installed Better Auth handler (no synthesized
 * documents), with the explicit HEAD/405/flag-off contract enforced by
 * mcp-discovery.ts, and the paths RESERVED before any SPA/SSR catch-all.
 *
 * Unit level: these exercise the FORWARDER through a fixture app. The
 * production ORDERING contract (aliases ahead of CORS / the global body
 * limiter in the real registration chain) is covered by app-order.test.ts,
 * which mounts the REAL createApp() output (L24).
 */

const grants = vi.hoisted(() => ({ findUnique: vi.fn(), create: vi.fn() }));
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    WMP_MCP_ENABLED: true,
    BETTER_AUTH_URL: "https://proxy.example.com",
    BETTER_AUTH_SECRET: "parity-test-secret-at-least-thirty-two-characters",
    CORS_ORIGIN: undefined,
  },
}));
vi.mock("@ws-model-proxy/db", () => ({ default: { mcpGrant: grants } }));

import { resolveMcpPlugins } from "../../../packages/auth/src/mcp-plugins";
import { createMcpDiscoveryForwarder, MCP_WELL_KNOWN_PATHS } from "./mcp-discovery";

const BASE = "https://proxy.example.com";
const ISSUER = `${BASE}/api/auth`;
const CANONICAL = `${BASE}/mcp`;
/**
 * Direct Host header for alias requests — hand-built undici Requests carry
 * none, and the canonical-authority boundary (Part F pass 2) requires one,
 * as real wire requests always do.
 */
const HOST = { host: "proxy.example.com" } as const;

beforeEach(() => {
  grants.findUnique.mockReset().mockResolvedValue(null);
  grants.create.mockReset().mockResolvedValue(null);
  // The shared fixtures keep their SPA-catch-all marker across tests; clear
  // it so each assertion observes only this test's request.
  for (const fixture of fixtures.values()) fixture.resetSpaProbe();
});

/**
 * Real installed handler + memory adapter (parity-test pattern).
 *
 * ONE auth instance per MCP flag for the whole file: the memory-adapter
 * instance and the Hono fixture are both construction-only (no test swaps
 * the plugin set or remounts middleware), so the flag-on and flag-off
 * fixtures are built in `beforeAll` and shared. The flag-off app differs
 * only in the forwarder's `enabled` gate — the auth instance stays flag-on
 * so the gate (not the plugin set) is what the flag-off rows observe.
 *
 * The DCR row does append one client row to the shared memory adapter. That
 * accumulation is harmless here: no row in this file asserts on a client
 * count, and each request derives its own PKCE verifier.
 *
 * State that DOES vary per test is reset in `beforeEach` (the `grants`
 * mocks and the SPA-catch-all marker), never carried on the shared app.
 */
function buildAuth() {
  const memory: Record<string, Record<string, unknown>[]> = {
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
  };
  return betterAuth({
    baseURL: BASE,
    secret: "parity-test-secret-at-least-thirty-two-characters",
    database: memoryAdapter(memory),
    emailAndPassword: { enabled: true },
    logger: { disabled: true },
    plugins: resolveMcpPlugins({ enabled: true, baseUrl: BASE }),
  });
}

/**
 * Forwarder fixture app: requestId + a minimal log middleware, then the four
 * aliases, then a body limiter, CORS, the auth handler, and an SPA-style
 * catch-all. NOT a production-order oracle — the ordering contract against
 * the REAL registration chain lives in app-order.test.ts (L24); this fixture
 * exists to exercise the forwarder's per-method contract ahead of handlers
 * that would otherwise answer (CORS 204, body limiter 413).
 */
function buildApp({ mcpEnabled }: { mcpEnabled: boolean }) {
  const auth = buildAuth();
  const app = new Hono<{ Variables: { requestId: string } }>();
  // requestId (production shape)
  app.use("/*", async (c, next) => {
    c.set("requestId", "probe0001");
    await next();
  });
  // request-log middleware (production shape: stock line for these paths)
  app.use("/*", async (c, next) => {
    await next();
    console.log(`[${c.get("requestId")}] stock ${c.req.method} ${c.req.path} ${c.res.status}`);
  });
  // The four aliases — immediately after requestId + request-log, BEFORE
  // CORS and the global body limiter (the pass-2 ordering contract).
  for (const path of MCP_WELL_KNOWN_PATHS) {
    app.all(
      path,
      createMcpDiscoveryForwarder({
        enabled: mcpEnabled,
        handler: (request) => auth.handler(request),
      }),
    );
  }
  // Global body limiter (production shape: 10 MB, standard 413).
  app.use(
    "/*",
    bodyLimit({
      maxSize: 10 * 1024 * 1024,
      onError: (c) => c.json({ error: "Request is too large. Try uploading a smaller file." }, 413),
    }),
  );
  // CORS (production shape when CORS_ORIGIN is set: answers OPTIONS 204).
  app.use("/*", cors({ origin: "https://app.example.com", credentials: true }));
  app.on(["GET", "POST", "HEAD", "PUT", "DELETE"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  let spaReached = false;
  app.all("/*", (c) => {
    spaReached = true;
    return c.html("<html><body>SPA SHELL</body></html>");
  });
  return { app, wasSpaReached: () => spaReached, resetSpaProbe: () => (spaReached = false) };
}

/**
 * Flag-scoped fixture cache, filled once in `beforeAll`. The SPA-catch-all
 * marker lives inside the cached app, so it is cleared per test by the
 * `beforeEach` below rather than by building a fresh app.
 */
const fixtures = new Map<string, ReturnType<typeof buildApp>>();

function fixtureKey(mcpEnabled: boolean): "on" | "off" {
  return mcpEnabled ? "on" : "off";
}

/** The shared fixture app (one per MCP flag). */
function fixtureApp(mcpEnabled: boolean): ReturnType<typeof buildApp>["app"] {
  const fixture = fixtures.get(fixtureKey(mcpEnabled));
  if (!fixture) throw new Error(`fixture not built for MCP flag ${fixtureKey(mcpEnabled)}`);
  return fixture.app;
}

/** The shared fixture's SPA-catch-all marker. */
function spaReached(mcpEnabled: boolean): boolean {
  const fixture = fixtures.get(fixtureKey(mcpEnabled));
  if (!fixture) throw new Error(`fixture not built for MCP flag ${fixtureKey(mcpEnabled)}`);
  return fixture.wasSpaReached();
}

beforeAll(() => {
  for (const mcpEnabled of [true, false]) {
    fixtures.set(fixtureKey(mcpEnabled), buildApp({ mcpEnabled }));
  }
});

const AUTH_SERVER_ALIASES = [
  "/.well-known/oauth-authorization-server/api/auth",
  "/api/auth/.well-known/oauth-authorization-server",
] as const;

const PROTECTED_RESOURCE_ALIASES = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
] as const;

describe("MCP discovery aliases against the real installed handler", () => {
  describe.each(AUTH_SERVER_ALIASES)("authorization-server metadata %s", (alias) => {
    it("GET returns the REAL provider metadata (issuer, endpoints, scopes, DCR)", async () => {
      const app = fixtureApp(true);
      const res = await app.request(`${BASE}${alias}`, { headers: HOST });
      expect(res.status).toBe(200);
      expect(spaReached(true)).toBe(false);
      const doc = (await res.json()) as Record<string, unknown>;
      expect(doc.issuer).toBe(ISSUER);
      expect(doc.authorization_endpoint).toBe(`${ISSUER}/oauth2/authorize`);
      expect(doc.token_endpoint).toBe(`${ISSUER}/oauth2/token`);
      expect(doc.jwks_uri).toBe(`${ISSUER}/jwks`);
      expect(doc.revocation_endpoint).toBe(`${ISSUER}/oauth2/revoke`);
      expect(doc.scopes_supported).toEqual(
        expect.arrayContaining(["mcp:read", "mcp:write", "offline_access"]),
      );
      // CIMD and RFC 7591 DCR are both advertised.
      expect(doc.client_id_metadata_document_supported).toBe(true);
      expect(doc.registration_endpoint).toBe(`${ISSUER}/oauth2/register`);
    });

    it("HEAD matches the GET status and headers with an EMPTY body", async () => {
      const app = fixtureApp(true);
      const getRes = await app.request(`${BASE}${alias}`, { headers: HOST });
      const headRes = await app.request(`${BASE}${alias}`, { method: "HEAD", headers: HOST });
      expect(headRes.status).toBe(getRes.status);
      expect(headRes.headers.get("content-type")).toBe(getRes.headers.get("content-type"));
      expect(headRes.headers.get("cache-control")).toBe(getRes.headers.get("cache-control"));
      expect(await headRes.text()).toBe("");
    });

    it.each(["PUT", "POST", "DELETE"] as const)(
      "%s → 405 with Allow: GET, HEAD (never reaches the handler for judging)",
      async (method) => {
        const app = fixtureApp(true);
        const res = await app.request(`${BASE}${alias}`, { method, headers: HOST });
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("GET, HEAD");
      },
    );

    it("flag OFF → 404 for every method; never falls through to the SPA/SSR catch-all", async () => {
      const app = fixtureApp(false);
      for (const method of ["GET", "HEAD", "PUT", "POST", "DELETE"] as const) {
        const res = await app.request(`${BASE}${alias}`, { method, headers: HOST });
        expect(res.status, `${method} ${alias}`).toBe(404);
      }
      expect(spaReached(false)).toBe(false);
    });
  });

  describe.each(PROTECTED_RESOURCE_ALIASES)("protected-resource metadata %s", (alias) => {
    it("GET returns the REAL RFC 9728 resource document (canonical resource, issuer)", async () => {
      const app = fixtureApp(true);
      const res = await app.request(`${BASE}${alias}`, { headers: HOST });
      expect(res.status).toBe(200);
      expect(spaReached(true)).toBe(false);
      const doc = (await res.json()) as Record<string, unknown>;
      expect(doc.resource).toBe(CANONICAL);
      expect(doc.authorization_servers).toEqual([ISSUER]);
      expect(doc.bearer_methods_supported).toEqual(["header"]);
      expect(doc.scopes_supported).toEqual(["mcp:read", "mcp:write"]);
    });

    it("HEAD matches the GET status and content-type with an EMPTY body", async () => {
      const app = fixtureApp(true);
      const getRes = await app.request(`${BASE}${alias}`, { headers: HOST });
      const headRes = await app.request(`${BASE}${alias}`, { method: "HEAD", headers: HOST });
      expect(headRes.status).toBe(getRes.status);
      expect(headRes.headers.get("content-type")).toBe(getRes.headers.get("content-type"));
      expect(await headRes.text()).toBe("");
    });

    it.each(["PUT", "POST", "DELETE"] as const)(
      "%s → 405 with Allow: GET, HEAD",
      async (method) => {
        const app = fixtureApp(true);
        const res = await app.request(`${BASE}${alias}`, { method, headers: HOST });
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("GET, HEAD");
      },
    );

    it("flag OFF → 404 for every method; never falls through to the SPA/SSR catch-all", async () => {
      const app = fixtureApp(false);
      for (const method of ["GET", "HEAD", "PUT", "POST", "DELETE"] as const) {
        const res = await app.request(`${BASE}${alias}`, { method, headers: HOST });
        expect(res.status, `${method} ${alias}`).toBe(404);
      }
      expect(spaReached(false)).toBe(false);
    });
  });

  it("no OpenID discovery document is served while openid is not configured", async () => {
    const app = fixtureApp(true);
    const res = await app.request(`${BASE}/api/auth/.well-known/openid-configuration`);
    expect(res.status).toBe(404);
  });

  it("DCR registration accepts unauthenticated clients within the configured scope ceiling", async () => {
    const app = fixtureApp(true);
    const res = await app.request(`${BASE}/api/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "dcr-attempt",
        redirect_uris: ["https://client.example.com/callback"],
      }),
    });
    expect(res.status).toBe(201);
    const registration = (await res.json()) as Record<string, unknown>;
    expect(registration).toMatchObject({
      client_name: "dcr-attempt",
      redirect_uris: ["https://client.example.com/callback"],
    });
    expect(typeof registration.client_id).toBe("string");
    expect(String(registration.scope).split(" ").sort()).toEqual(
      ["mcp:read", "mcp:write", "offline_access"].sort(),
    );
  });

  it("JWKS stays GET-only: HEAD /api/auth/jwks is NOT given a HEAD adapter (upstream 404)", async () => {
    const app = fixtureApp(true);
    const getRes = await app.request(`${BASE}/api/auth/jwks`);
    expect(getRes.status).toBe(200);
    const headRes = await app.request(`${BASE}/api/auth/jwks`, { method: "HEAD" });
    expect(headRes.status).toBe(404);
  });
});
