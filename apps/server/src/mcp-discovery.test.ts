import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
});

/** Real installed handler + memory adapter (parity-test pattern). */
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
  return { app, wasSpaReached: () => spaReached };
}

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
    it("GET returns the REAL provider metadata (issuer, endpoints, scopes; no DCR)", async () => {
      const { app, wasSpaReached } = buildApp({ mcpEnabled: true });
      const res = await app.request(`${BASE}${alias}`, { headers: HOST });
      expect(res.status).toBe(200);
      expect(wasSpaReached()).toBe(false);
      const doc = (await res.json()) as Record<string, unknown>;
      expect(doc.issuer).toBe(ISSUER);
      expect(doc.authorization_endpoint).toBe(`${ISSUER}/oauth2/authorize`);
      expect(doc.token_endpoint).toBe(`${ISSUER}/oauth2/token`);
      expect(doc.jwks_uri).toBe(`${ISSUER}/jwks`);
      expect(doc.revocation_endpoint).toBe(`${ISSUER}/oauth2/revoke`);
      expect(doc.scopes_supported).toEqual(
        expect.arrayContaining(["mcp:read", "mcp:write", "offline_access"]),
      );
      // CIMD advertisement present; RFC 7591 DCR registration endpoint absent.
      expect(doc.client_id_metadata_document_supported).toBe(true);
      expect(doc.registration_endpoint).toBeUndefined();
      expect(JSON.stringify(doc)).not.toContain("registration_endpoint");
    });

    it("HEAD matches the GET status and headers with an EMPTY body", async () => {
      const { app } = buildApp({ mcpEnabled: true });
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
        const { app } = buildApp({ mcpEnabled: true });
        const res = await app.request(`${BASE}${alias}`, { method, headers: HOST });
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("GET, HEAD");
      },
    );

    it("flag OFF → 404 for every method; never falls through to the SPA/SSR catch-all", async () => {
      const { app, wasSpaReached } = buildApp({ mcpEnabled: false });
      for (const method of ["GET", "HEAD", "PUT", "POST", "DELETE"] as const) {
        const res = await app.request(`${BASE}${alias}`, { method, headers: HOST });
        expect(res.status, `${method} ${alias}`).toBe(404);
      }
      expect(wasSpaReached()).toBe(false);
    });
  });

  describe.each(PROTECTED_RESOURCE_ALIASES)("protected-resource metadata %s", (alias) => {
    it("GET returns the REAL RFC 9728 resource document (canonical resource, issuer)", async () => {
      const { app, wasSpaReached } = buildApp({ mcpEnabled: true });
      const res = await app.request(`${BASE}${alias}`, { headers: HOST });
      expect(res.status).toBe(200);
      expect(wasSpaReached()).toBe(false);
      const doc = (await res.json()) as Record<string, unknown>;
      expect(doc.resource).toBe(CANONICAL);
      expect(doc.authorization_servers).toEqual([ISSUER]);
      expect(doc.bearer_methods_supported).toEqual(["header"]);
      expect(doc.scopes_supported).toEqual(["mcp:read", "mcp:write"]);
    });

    it("HEAD matches the GET status and content-type with an EMPTY body", async () => {
      const { app } = buildApp({ mcpEnabled: true });
      const getRes = await app.request(`${BASE}${alias}`, { headers: HOST });
      const headRes = await app.request(`${BASE}${alias}`, { method: "HEAD", headers: HOST });
      expect(headRes.status).toBe(getRes.status);
      expect(headRes.headers.get("content-type")).toBe(getRes.headers.get("content-type"));
      expect(await headRes.text()).toBe("");
    });

    it.each(["PUT", "POST", "DELETE"] as const)(
      "%s → 405 with Allow: GET, HEAD",
      async (method) => {
        const { app } = buildApp({ mcpEnabled: true });
        const res = await app.request(`${BASE}${alias}`, { method, headers: HOST });
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("GET, HEAD");
      },
    );

    it("flag OFF → 404 for every method; never falls through to the SPA/SSR catch-all", async () => {
      const { app, wasSpaReached } = buildApp({ mcpEnabled: false });
      for (const method of ["GET", "HEAD", "PUT", "POST", "DELETE"] as const) {
        const res = await app.request(`${BASE}${alias}`, { method, headers: HOST });
        expect(res.status, `${method} ${alias}`).toBe(404);
      }
      expect(wasSpaReached()).toBe(false);
    });
  });

  it("no OpenID discovery document is served while openid is not configured", async () => {
    const { app } = buildApp({ mcpEnabled: true });
    const res = await app.request(`${BASE}/api/auth/.well-known/openid-configuration`);
    expect(res.status).toBe(404);
  });

  it("DCR registration is refused: POST /api/auth/oauth2/register → 403 access_denied", async () => {
    const { app } = buildApp({ mcpEnabled: true });
    const res = await app.request(`${BASE}/api/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "dcr-attempt",
        redirect_uris: ["https://client.example.com/callback"],
      }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "access_denied" });
  });

  it("JWKS stays GET-only: HEAD /api/auth/jwks is NOT given a HEAD adapter (upstream 404)", async () => {
    const { app } = buildApp({ mcpEnabled: true });
    const getRes = await app.request(`${BASE}/api/auth/jwks`);
    expect(getRes.status).toBe(200);
    const headRes = await app.request(`${BASE}/api/auth/jwks`, { method: "HEAD" });
    expect(headRes.status).toBe(404);
  });
});
