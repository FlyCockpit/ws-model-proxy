import { createHash } from "node:crypto";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Committed real-handler parity tests (Part D pass 3, L21): the authorize
 * boundary in mcp-authorize-scope-guard.ts must judge exactly the request
 * the INSTALLED downstream stack (better-auth@1.7.3 → better-call@1.4.0
 * getBody + oauth-provider query parsing) would judge. Every fixture here
 * mounts the guard in front of a real `betterAuth` instance (memory
 * adapter, real resolveMcpPlugins with the flag on, mocked Prisma mcpGrant
 * table) and asserts the PINNED downstream semantics end to end.
 *
 * Coverage split (pass 4): the skipConsent: true fixtures below cover
 * PARSER parity (guard vs installed better-call/oauth-provider parsing);
 * the consent-enabled fixture at the bottom covers the FULL consent flow
 * (authorize → consent page → consent accept → code exchange → grant
 * minting) and the L17 referenceId continuity (consent row referenceId ===
 * the grant's referenceId), and the consent page's Read-only/Full choice
 * (mcp-consent-level.ts): only the person's `level` sets the grant level.
 *
 * The mocked mcpGrant table is a small in-memory store keyed like the real
 * unique (userId, clientId, referenceId), so consent-time and exchange-time
 * writes see each other.
 */

type GrantRow = {
  id: string;
  userId: string;
  clientId: string;
  referenceId: string;
  level: "READ" | "FULL";
  revokedAt: Date | null;
};
type GrantKey = { userId: string; clientId: string; referenceId: string };
const store = vi.hoisted(() => ({ rows: [] as GrantRow[], audits: [] as unknown[] }));
const grants = vi.hoisted(() => ({
  findUnique: vi.fn(),
  create: vi.fn(),
  createMany: vi.fn(),
  updateMany: vi.fn(),
}));
const audits = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    WMP_MCP_ENABLED: true,
    BETTER_AUTH_URL: "https://proxy.example.com",
    BETTER_AUTH_SECRET: "parity-test-secret-at-least-thirty-two-characters",
    CORS_ORIGIN: undefined,
  },
}));
vi.mock("@ws-model-proxy/db", () => {
  const tx = { mcpGrant: grants, auditEvent: audits };
  return {
    default: {
      ...tx,
      $transaction: (run: (client: typeof tx) => Promise<unknown>) => run(tx),
    },
  };
});

import {
  type McpGrantLevelLoweredEvent,
  onMcpGrantLevelLowered,
} from "../../../packages/auth/src/mcp-grant-level";
import { resolveMcpPlugins } from "../../../packages/auth/src/mcp-plugins";
import { mcpAuthorizeScopeGuard } from "./mcp-authorize-scope-guard";

function findRow(key: GrantKey): GrantRow | undefined {
  return store.rows.find(
    (row) =>
      row.userId === key.userId &&
      row.clientId === key.clientId &&
      row.referenceId === key.referenceId,
  );
}

function createRow(data: GrantKey & { level?: "READ" | "FULL" }): GrantRow {
  const row: GrantRow = {
    id: `parity-grant-${store.rows.length + 1}`,
    userId: data.userId,
    clientId: data.clientId,
    referenceId: data.referenceId,
    level: data.level ?? "READ",
    revokedAt: null,
  };
  store.rows.push(row);
  return row;
}

const BASE = "https://proxy.example.com";
const CANONICAL = `${BASE}/mcp`;
const AUTHORIZE = "/api/auth/oauth2/authorize";
const CLIENT = "parity-client";
const CALLBACK = "https://client.example.com/callback";
const VERIFIER = "parity-pkce-verifier-at-least-forty-three-characters";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const FORM = "application/x-www-form-urlencoded";
const HYBRID_JSON = "application/json+application/x-www-form-urlencoded";

const oauthParams = {
  response_type: "code",
  client_id: CLIENT,
  redirect_uri: CALLBACK,
  code_challenge: CHALLENGE,
  code_challenge_method: "S256",
};

beforeEach(() => {
  store.rows = [];
  store.audits = [];
  grants.findUnique
    .mockReset()
    .mockImplementation(async (args: { where: { userId_clientId_referenceId: GrantKey } }) => {
      const row = findRow(args.where.userId_clientId_referenceId);
      return row ? { ...row } : null;
    });
  grants.create
    .mockReset()
    .mockImplementation(async (args: { data: GrantKey }) => ({ ...createRow(args.data) }));
  // ON CONFLICT DO NOTHING, like `skipDuplicates`.
  grants.createMany
    .mockReset()
    .mockImplementation(async (args: { data: Array<GrantKey & { level: "READ" | "FULL" }> }) => {
      let count = 0;
      for (const data of args.data) {
        if (findRow(data)) continue;
        createRow(data);
        count += 1;
      }
      return { count };
    });
  grants.updateMany
    .mockReset()
    .mockImplementation(
      async (args: {
        where: { id: string; userId: string; revokedAt: null; level: "READ" | "FULL" };
        data: { level: "READ" | "FULL" };
      }) => {
        const row = store.rows.find(
          (candidate) =>
            candidate.id === args.where.id &&
            candidate.userId === args.where.userId &&
            candidate.revokedAt === null &&
            candidate.level === args.where.level,
        );
        if (!row) return { count: 0 };
        row.level = args.data.level;
        return { count: 1 };
      },
    );
  audits.create.mockReset().mockImplementation(async (args: { data: unknown }) => {
    store.audits.push(args.data);
    return args.data;
  });
});

function buildApp({
  skipConsent = true,
  originCheck = false,
}: {
  skipConsent?: boolean;
  originCheck?: boolean;
} = {}) {
  const memory: Record<string, Record<string, unknown>[]> = {
    oauthAccessToken: [],
    oauthRefreshToken: [],
    oauthConsent: [],
    oauthClientAssertion: [],
    jwks: [],
    // The client is LINKED to the canonical MCP resource (enforcePerClient
    // Resources is on): requests carrying it pass per-client enforcement.
    oauthResource: [
      {
        id: "parity-resource-row",
        identifier: CANONICAL,
        disabled: false,
        allowedScopes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    oauthClientResource: [
      { id: "parity-link-row", clientId: CLIENT, resourceId: CANONICAL, createdAt: new Date() },
    ],
    user: [],
    session: [],
    account: [],
    verification: [],
    oauthClient: [
      {
        id: "parity-client-row",
        clientId: CLIENT,
        tokenEndpointAuthMethod: "none",
        redirectUris: [CALLBACK],
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        scopes: ["mcp:read", "mcp:write", "offline_access"],
        skipConsent,
        requirePKCE: true,
        disabled: false,
      },
    ],
  };
  const auth = betterAuth({
    baseURL: BASE,
    secret: "parity-test-secret-at-least-thirty-two-characters",
    database: memoryAdapter(memory),
    // Test-only hasher (the two-factor-lockout.test.ts pattern): this suite
    // proves the AUTHORIZE boundary parity, never password hashing, and real
    // scrypt dominated its runtime. No assertion here reads the stored hash
    // format or the scrypt parameters.
    emailAndPassword: {
      enabled: true,
      password: {
        hash: async (password) => `fast:${password}`,
        verify: async ({ hash, password }) => hash === `fast:${password}`,
      },
    },
    logger: { disabled: true },
    // Better Auth skips its origin (CSRF) check under test unless told otherwise; production
    // runs it. The cross-site consent case turns it on.
    ...(originCheck ? { advanced: { disableOriginCheck: false } } : {}),
    plugins: resolveMcpPlugins({ enabled: true, baseUrl: BASE }),
  });
  const app = new Hono();
  app.use(AUTHORIZE, mcpAuthorizeScopeGuard);
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  return { app, auth, memory };
}

const formBody = (extra: Record<string, string>) =>
  new URLSearchParams({ ...oauthParams, ...extra }).toString();

/** Form body with a UTF-8 BOM glued to `firstKey`'s name — the field Better
 * Auth would then not recognize (downstream parity hazard shape). */
const bomBody = (firstKey: string, extra: Record<string, string>) =>
  "\uFEFF" +
  new URLSearchParams({ [firstKey]: extra[firstKey], ...extra, ...oauthParams }).toString();

describe("MCP authorize boundary parity with the installed handler", () => {
  it("BOM-prefixed scope form field → LOCAL invalid_scope (never the downstream full-scope default)", async () => {
    const { app } = buildApp();
    const res = await app.request(`${BASE}${AUTHORIZE}`, {
      method: "POST",
      headers: { "content-type": FORM, origin: BASE },
      body: bomBody("scope", { scope: "mcp:read", resource: CANONICAL }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.json()).toMatchObject({ error: "invalid_scope" });
  });

  it("BOM-prefixed resource form field → LOCAL invalid_target (no redirect, no code)", async () => {
    const { app } = buildApp();
    const res = await app.request(`${BASE}${AUTHORIZE}`, {
      method: "POST",
      headers: { "content-type": FORM, origin: BASE },
      body: bomBody("resource", { resource: CANONICAL, scope: "mcp:read" }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.json()).toMatchObject({ error: "invalid_target" });
    expect(grants.findUnique).not.toHaveBeenCalled();
    expect(grants.create).not.toHaveBeenCalled();
  });

  describe("hybrid JSON content type (application/json+application/x-www-form-urlencoded)", () => {
    const post = (app: Hono, payload: unknown) =>
      app.request(`${BASE}${AUTHORIZE}`, {
        method: "POST",
        headers: { "content-type": HYBRID_JSON, origin: BASE },
        body: JSON.stringify(payload),
      });

    it("missing scope → LOCAL invalid_scope, non-redirecting", async () => {
      const { app } = buildApp();
      const res = await post(app, { ...oauthParams, resource: CANONICAL });
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.json()).toMatchObject({ error: "invalid_scope" });
    });

    it("blank scope → LOCAL invalid_scope, non-redirecting", async () => {
      const { app } = buildApp();
      const res = await post(app, { ...oauthParams, scope: "   ", resource: CANONICAL });
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.json()).toMatchObject({ error: "invalid_scope" });
    });

    it("missing resource → LOCAL invalid_target, non-redirecting", async () => {
      const { app } = buildApp();
      const res = await post(app, { ...oauthParams, scope: "mcp:read" });
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.json()).toMatchObject({ error: "invalid_target" });
    });

    it("valid scope + canonical resource → forwarded (login redirect)", async () => {
      const { app } = buildApp();
      const res = await post(app, { ...oauthParams, scope: "mcp:read", resource: CANONICAL });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("/mcp-login");
    });
  });

  it("repeated form resource keys: foreign LAST → LOCAL invalid_target", async () => {
    const { app } = buildApp();
    const res = await app.request(`${BASE}${AUTHORIZE}`, {
      method: "POST",
      headers: { "content-type": FORM, origin: BASE },
      body: `scope=mcp:read&resource=${encodeURIComponent(CANONICAL)}&resource=${encodeURIComponent("https://foreign.example.com/mcp")}&${new URLSearchParams(oauthParams)}`,
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.json()).toMatchObject({ error: "invalid_target" });
  });

  it("repeated form resource keys: canonical LAST → forwarded, login redirect carries canonical only", async () => {
    const { app } = buildApp();
    const res = await app.request(`${BASE}${AUTHORIZE}`, {
      method: "POST",
      headers: { "content-type": FORM, origin: BASE },
      body: `scope=mcp:read&resource=${encodeURIComponent("https://foreign.example.com/mcp")}&resource=${encodeURIComponent(CANONICAL)}&${new URLSearchParams(oauthParams)}`,
    });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!, BASE);
    expect(location.pathname).toContain("/mcp-login");
    const query = location.searchParams;
    expect(query.get("scope")).toBe("mcp:read");
    expect(query.getAll("resource")).toEqual([CANONICAL]);
  });

  it("space-delimited resource value (`R R`) → LOCAL invalid_target (no space-split union at authorize)", async () => {
    const { app } = buildApp();
    const res = await app.request(`${BASE}${AUTHORIZE}`, {
      method: "POST",
      headers: { "content-type": FORM, origin: BASE },
      body: formBody({ scope: "mcp:read", resource: `${CANONICAL} ${CANONICAL}` }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.json()).toMatchObject({ error: "invalid_target" });
  });

  it("GET duplicate scope → FORWARDED; downstream redirects invalid_request", async () => {
    const { app } = buildApp();
    const query = new URLSearchParams({
      ...oauthParams,
      scope: "mcp:read",
      resource: CANONICAL,
    });
    query.append("scope", "mcp:write");
    const res = await app.request(`${BASE}${AUTHORIZE}?${query.toString()}`);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!, BASE);
    expect(location.searchParams.get("error")).toBe("invalid_request");
  });

  it("GET duplicate resource (array incl. canonical) → FORWARDED (downstream per-client enforcement owns it)", async () => {
    const { app } = buildApp();
    const query = new URLSearchParams({ ...oauthParams, scope: "mcp:read" });
    query.append("resource", "https://foreign.example.com/mcp");
    query.append("resource", CANONICAL);
    const res = await app.request(`${BASE}${AUTHORIZE}?${query.toString()}`);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!, BASE);
    // Forwarded past the boundary: downstream per-client resource
    // enforcement answers via the VALIDATED client redirect_uri (the client
    // is linked to the canonical resource only, so the foreign member of the
    // array is rejected there) — NOT a local guard 400.
    expect(location.origin + location.pathname).toBe(CALLBACK);
    expect(location.searchParams.get("error")).toBe("invalid_target");
  });

  it("multipart/form-data and pure application/json authorize POSTs → FORWARDED, downstream 415", async () => {
    const { app } = buildApp();
    const multipart = new FormData();
    multipart.set("scope", "mcp:read");
    multipart.set("resource", CANONICAL);
    const mpRes = await app.request(`${BASE}${AUTHORIZE}`, {
      method: "POST",
      headers: { origin: BASE },
      body: multipart,
    });
    expect(mpRes.status).toBe(415);

    const jsonRes = await app.request(`${BASE}${AUTHORIZE}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ ...oauthParams, scope: "mcp:read", resource: CANONICAL }),
    });
    expect(jsonRes.status).toBe(415);
  });

  it("charset-param form content type is normally handled (forwarded to login redirect)", async () => {
    const { app } = buildApp();
    const res = await app.request(`${BASE}${AUTHORIZE}`, {
      method: "POST",
      headers: { "content-type": `${FORM}; charset=utf-8`, origin: BASE },
      body: formBody({ scope: "mcp:read", resource: CANONICAL }),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/mcp-login");
  });

  it("ordinary valid form POST → forwarded, login redirect observed", async () => {
    const { app } = buildApp();
    const res = await app.request(`${BASE}${AUTHORIZE}`, {
      method: "POST",
      headers: { "content-type": FORM, origin: BASE },
      body: formBody({ scope: "mcp:read offline_access", resource: CANONICAL }),
    });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!, BASE);
    expect(location.pathname).toContain("/mcp-login");
    expect(location.searchParams.get("scope")).toBe("mcp:read offline_access");
  });

  it("FULL FLOW: resource-bound authorize → consent → code exchange runs the claims hook and mints a JWT with mcp_grant_id", async () => {
    const { app, auth } = buildApp();
    const signup = await auth.api.signUpEmail({
      body: { name: "Parity", email: "parity@example.test", password: "parity-test-password-123" },
      asResponse: true,
    });
    expect(signup.status).toBe(200);
    const cookie = signup.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");

    const authorize = await app.request(`${BASE}${AUTHORIZE}`, {
      method: "POST",
      headers: { "content-type": FORM, cookie, origin: BASE },
      body: formBody({ scope: "mcp:read offline_access", resource: CANONICAL }),
    });
    expect(authorize.status).toBe(302);
    const location = new URL(authorize.headers.get("location")!, BASE);
    expect(location.origin + location.pathname).toBe(CALLBACK);
    const code = location.searchParams.get("code");
    expect(code).toBeTruthy();

    const token = await app.request(`${BASE}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": FORM },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT,
        code: code!,
        code_verifier: VERIFIER,
        redirect_uri: CALLBACK,
      }),
    });
    expect(token.status).toBe(200);
    const json = (await token.json()) as { access_token: string };
    // The claims hook RAN: the mocked mcpGrant table was consulted + written.
    expect(grants.findUnique).toHaveBeenCalled();
    expect(grants.create).toHaveBeenCalledTimes(1);
    const created = grants.create.mock.calls[0]?.[0] as {
      data: { userId: string; clientId: string; referenceId: string };
    };
    expect(created.data.clientId).toBe(CLIENT);
    expect(created.data.referenceId).toMatch(/^[0-9a-f]{64}$/);
    // The token is a self-contained JWT carrying the private grant claim.
    const segments = json.access_token.split(".");
    expect(segments).toHaveLength(3);
    const claims = JSON.parse(
      Buffer.from(segments[1] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(claims.mcp_grant_id).toBe(store.rows[0]?.id);
    // A skip-consent client never saw the page: its grant is Read-only.
    expect(store.rows[0]?.level).toBe("READ");
  });

  it("FULL FLOW hazard closed: BOM-prefixed resource authorize is locally rejected — no guard-passing shape reaches token issuance without the hook", async () => {
    const { app, auth } = buildApp();
    const signup = await auth.api.signUpEmail({
      body: {
        name: "Bommed",
        email: "bom@example.test",
        password: "parity-test-password-123",
      },
      asResponse: true,
    });
    const cookie = signup.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
    const res = await app.request(`${BASE}${AUTHORIZE}`, {
      method: "POST",
      headers: { "content-type": FORM, cookie, origin: BASE },
      body: bomBody("resource", { scope: "mcp:read", resource: CANONICAL }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.json()).toMatchObject({ error: "invalid_target" });
    expect(grants.findUnique).not.toHaveBeenCalled();
    expect(grants.create).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // L18 (pass 4) — raw-pathname applicability against the REAL handler:
  // percent-encoded authorize paths are NOT the route downstream
  // (better-call routes on the raw pathname → 404), so the guard must
  // skip and never answer them locally.
  // ------------------------------------------------------------------

  it.each([
    [`${BASE}/api/auth/oauth2/%61uthorize`, "%61 for 'a'"],
    [`${BASE}/api/auth/oauth2/authoriz%65`, "%65 for 'e'"],
  ])("RAW pathname %s: guard SKIPS, downstream 404 (not a local 400) — %s", async (url) => {
    const { app } = buildApp();
    const res = await app.request(url, {
      method: "POST",
      headers: { "content-type": FORM, origin: BASE },
      body: formBody({ scope: "", resource: CANONICAL }),
    });
    expect(res.status).toBe(404);
  });

  it("HEAD /api/auth/oauth2/authorize without scope → guard SKIPS (HEAD not-applicable), downstream 404 (NOT 400)", async () => {
    // L18 (pass 5): the provider registers GET/POST only, so better-call's
    // findRoute 404s HEAD. Judging HEAD in the guard would answer a request
    // downstream never serves. Before the fix this returned a LOCAL 400
    // invalid_scope from the GET query branch.
    const { app } = buildApp();
    const res = await app.request(`${BASE}${AUTHORIZE}`, { method: "HEAD" });
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
    expect(grants.findUnique).not.toHaveBeenCalled();
    expect(grants.create).not.toHaveBeenCalled();
  });

  it("form-admissible but unform-parseable content type → LOCAL 400 invalid_request (was: downstream 500 + raw TypeError)", async () => {
    const { app } = buildApp();
    const res = await app.request(`${BASE}${AUTHORIZE}`, {
      method: "POST",
      headers: { "content-type": "text/application/x-www-form-urlencoded", origin: BASE },
      body: formBody({ scope: "mcp:read", resource: CANONICAL }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });

  // ------------------------------------------------------------------
  // L21 (pass 4) — consent-enabled FULL flow (fixture client with
  // skipConsent: false), steps pinned against the installed provider.
  // The skipConsent fixtures above cover parser parity; THIS one covers
  // the consent round-trip and the L17 referenceId continuity.
  // ------------------------------------------------------------------

  it("CONSENT FULL FLOW: authorize → consent page → consent accept → code exchange; oauthConsent row and grant share the referenceId", async () => {
    const { app, auth, memory } = buildApp({ skipConsent: false });

    // 1. signUpEmail → session cookie.
    const signup = await auth.api.signUpEmail({
      body: {
        name: "Consentful",
        email: "consent@example.test",
        password: "parity-test-password-123",
      },
      asResponse: true,
    });
    expect(signup.status).toBe(200);
    const cookie = signup.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");

    // 2. authorize (form, cookie, origin) → 302 to the consent page with
    //    the signed OAuth query.
    const authorize = await app.request(`${BASE}${AUTHORIZE}`, {
      method: "POST",
      headers: { "content-type": FORM, cookie, origin: BASE },
      body: formBody({ scope: "mcp:read offline_access", resource: CANONICAL }),
    });
    expect(authorize.status).toBe(302);
    const authorizeLocation = new URL(authorize.headers.get("location")!, BASE);
    expect(authorizeLocation.pathname).toContain("/mcp-consent");
    expect(authorizeLocation.search.length).toBeGreaterThan(0);

    // 3. consent accept (JSON, cookie, origin) → 200 {redirect: true, url}.
    const consent = await app.request(`${BASE}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: BASE },
      body: JSON.stringify({
        accept: true,
        oauth_query: authorizeLocation.search.slice(1),
      }),
    });
    expect(consent.status).toBe(200);
    const consentJson = (await consent.json()) as { redirect: boolean; url: string };
    expect(consentJson.redirect).toBe(true);
    expect(consentJson.url).toBeTruthy();

    // 4. Exactly one oauthConsent row; its referenceId is the 64-hex HMAC.
    expect(memory.oauthConsent ?? []).toHaveLength(1);
    const consentRow = (memory.oauthConsent ?? [])[0] as { referenceId?: unknown } | undefined;
    expect(consentRow?.referenceId).toMatch(/^[a-f0-9]{64}$/);

    // 5. The approval created the grant (at the default Read-only level)
    //    under the CONSENT row's referenceId (L17 continuity), before the
    //    code reached the browser.
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      referenceId: consentRow?.referenceId,
      clientId: CLIENT,
      level: "READ",
      revokedAt: null,
    });

    // 6. Exchange the code (authorization_code + PKCE verifier) → 200;
    //    3-segment JWT carrying mcp_grant_id of that grant; the exchange
    //    reuses it (no second create).
    const redirectUrl = new URL(consentJson.url, BASE);
    const code = redirectUrl.searchParams.get("code");
    expect(code).toBeTruthy();
    const token = await app.request(`${BASE}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": FORM },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT,
        code: code!,
        code_verifier: VERIFIER,
        redirect_uri: CALLBACK,
      }),
    });
    expect(token.status).toBe(200);
    const tokenJson = (await token.json()) as { access_token: string };
    expect(grants.create).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(1);
    const segments = tokenJson.access_token.split(".");
    expect(segments).toHaveLength(3);
    const claims = JSON.parse(
      Buffer.from(segments[1] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(claims.mcp_grant_id).toBe(store.rows[0]?.id);
  });

  // ------------------------------------------------------------------
  // Phase 9 (Part K1) — consent-memory contract rows against the REAL
  // installed handler (authorize-9whjxVLJ.mjs consent skip logic): a
  // remembered consent (oauthConsent row found by clientId+userId+
  // referenceId, requested scopes ⊆ consent.scopes, resources covered)
  // SKIPS the consent page; a scope STEP-UP (any scope outside the
  // remembered set) forces a re-prompt; a DENIAL (accept: false) redirects
  // to the validated redirect_uri with error=access_denied and never mints
  // a code or a grant.
  // ------------------------------------------------------------------

  /** signUpEmail on a consent-enabled fixture and return the session cookie. */
  async function consentFixtureUser(
    app: Hono,
    auth: ReturnType<typeof buildApp>["auth"],
    email: string,
  ): Promise<string> {
    void app;
    const signup = await auth.api.signUpEmail({
      body: { name: "Consent Memory", email, password: "parity-test-password-123" },
      asResponse: true,
    });
    expect(signup.status).toBe(200);
    return signup.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
  }

  /** authorize → expect the consent-page redirect → accept → return the code URL. */
  async function authorizeExpectConsent(app: Hono, cookie: string, scope: string): Promise<URL> {
    const authorize = await app.request(`${BASE}${AUTHORIZE}`, {
      method: "POST",
      headers: { "content-type": FORM, cookie, origin: BASE },
      body: formBody({ scope, resource: CANONICAL }),
    });
    expect(authorize.status).toBe(302);
    const location = new URL(authorize.headers.get("location")!, BASE);
    expect(location.pathname).toContain("/mcp-consent");
    const consent = await app.request(`${BASE}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: BASE },
      body: JSON.stringify({ accept: true, oauth_query: location.search.slice(1) }),
    });
    expect(consent.status).toBe(200);
    const consentJson = (await consent.json()) as { redirect: boolean; url: string };
    expect(consentJson.redirect).toBe(true);
    return new URL(consentJson.url, BASE);
  }

  it("REMEMBERED CONSENT: second authorize with the SAME scopes skips the consent page and issues a code directly", async () => {
    const { app, auth, memory } = buildApp({ skipConsent: false });
    const cookie = await consentFixtureUser(app, auth, "remembered@example.test");

    const firstUrl = await authorizeExpectConsent(app, cookie, "mcp:read offline_access");
    expect(firstUrl.searchParams.get("code")).toBeTruthy();
    expect(memory.oauthConsent ?? []).toHaveLength(1);

    // Second authorize, SAME session + SAME scope set: the installed
    // provider finds the remembered oauthConsent row (scopes ⊆ consent
    // scopes, resource covered) and redirects STRAIGHT to the callback with
    // a code — no consent page, no new consent row.
    const second = await app.request(`${BASE}${AUTHORIZE}`, {
      method: "POST",
      headers: { "content-type": FORM, cookie, origin: BASE },
      body: formBody({ scope: "mcp:read offline_access", resource: CANONICAL }),
    });
    expect(second.status).toBe(302);
    const location = new URL(second.headers.get("location")!, BASE);
    expect(location.origin + location.pathname).toBe(CALLBACK);
    expect(location.searchParams.get("code")).toBeTruthy();
    expect(memory.oauthConsent ?? []).toHaveLength(1);
  });

  it("SCOPE STEP-UP: remembered consent with FEWER scopes + an authorize with an ADDITIONAL scope forces a consent re-prompt", async () => {
    const { app, auth, memory } = buildApp({ skipConsent: false });
    const cookie = await consentFixtureUser(app, auth, "stepup@example.test");

    // Remember a consent for mcp:read only.
    await authorizeExpectConsent(app, cookie, "mcp:read");
    expect(memory.oauthConsent ?? []).toHaveLength(1);

    // Step-up request adds mcp:write: the remembered row does NOT cover the
    // requested scope set (`!requestedScopes.every((s) => consent.scopes
    // .includes(s))` in the installed authorize), so the consent page
    // re-prompts — for the FULL requested scope set (mcp:read mcp:write),
    // NOT just the delta: the installed provider signs and persists the
    // whole authorization query (authorize-9whjxVLJ.mjs:5660-5684 signs the
    // full query; :55-117 persists the accepted full scope set).
    //
    // Coverage qualification (review round 1): these same-session,
    // same-client fixtures detect loss of remembered-consent reuse, a
    // missing step-up prompt, and denial returning a code. They do NOT
    // independently pin consent-lookup isolation across different clients,
    // users, referenceIds, or resources (dropping those lookup predicates
    // could leave these tests green), nor subset-reuse semantics. New-
    // session consent isolation is explicitly deferred to K2.
    const stepUp = await app.request(`${BASE}${AUTHORIZE}`, {
      method: "POST",
      headers: { "content-type": FORM, cookie, origin: BASE },
      body: formBody({ scope: "mcp:read mcp:write", resource: CANONICAL }),
    });
    expect(stepUp.status).toBe(302);
    const location = new URL(stepUp.headers.get("location")!, BASE);
    expect(location.pathname).toContain("/mcp-consent");

    // Accepting the step-up stores the EXPANDED scope set and issues a code.
    const consent = await app.request(`${BASE}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: BASE },
      body: JSON.stringify({ accept: true, oauth_query: location.search.slice(1) }),
    });
    expect(consent.status).toBe(200);
    const consentJson = (await consent.json()) as { redirect: boolean; url: string };
    expect(consentJson.redirect).toBe(true);
    const codeUrl = new URL(consentJson.url, BASE);
    expect(codeUrl.searchParams.get("code")).toBeTruthy();
    const rows = memory.oauthConsent ?? [];
    const scopeSets = rows.map((row) => (row.scopes as string[]) ?? []);
    expect(scopeSets.some((scopes) => scopes.includes("mcp:write"))).toBe(true);

    // A subsequent FULL-SET authorize now skips the prompt (the remembered
    // set covers it).
    const after = await app.request(`${BASE}${AUTHORIZE}`, {
      method: "POST",
      headers: { "content-type": FORM, cookie, origin: BASE },
      body: formBody({ scope: "mcp:read mcp:write", resource: CANONICAL }),
    });
    expect(after.status).toBe(302);
    const afterLocation = new URL(after.headers.get("location")!, BASE);
    expect(afterLocation.origin + afterLocation.pathname).toBe(CALLBACK);
    expect(afterLocation.searchParams.get("code")).toBeTruthy();
  });

  it("CONSENT DENIAL: accept:false redirects to the validated redirect_uri with access_denied — no code, no grant, no consent row", async () => {
    const { app, auth, memory } = buildApp({ skipConsent: false });
    grants.create.mockClear();
    const cookie = await consentFixtureUser(app, auth, "denial@example.test");

    const authorize = await app.request(`${BASE}${AUTHORIZE}`, {
      method: "POST",
      headers: { "content-type": FORM, cookie, origin: BASE },
      body: formBody({ scope: "mcp:read offline_access", resource: CANONICAL }),
    });
    expect(authorize.status).toBe(302);
    const location = new URL(authorize.headers.get("location")!, BASE);
    expect(location.pathname).toContain("/mcp-consent");

    const denial = await app.request(`${BASE}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: BASE },
      body: JSON.stringify({ accept: false, oauth_query: location.search.slice(1) }),
    });
    expect(denial.status).toBe(200);
    const denialJson = (await denial.json()) as { redirect: boolean; url: string };
    expect(denialJson.redirect).toBe(true);
    // The installed denial contract: formatErrorURL over the VALIDATED
    // client redirect_uri with error=access_denied — never a code.
    const denialUrl = new URL(denialJson.url, BASE);
    expect(denialUrl.origin + denialUrl.pathname).toBe(CALLBACK);
    expect(denialUrl.searchParams.get("error")).toBe("access_denied");
    expect(denialUrl.searchParams.get("code")).toBeNull();
    // No grant was minted and no consent was remembered.
    expect(grants.create).not.toHaveBeenCalled();
    expect(grants.createMany).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(0);
    expect(memory.oauthConsent ?? []).toHaveLength(0);
  });

  // ------------------------------------------------------------------
  // The consent page's Read-only/Full choice (mcp-consent-level.ts): the
  // level comes from the PERSON's consent body only, defaults to Read-only,
  // and is recorded on the exact grant the code exchanges into.
  // ------------------------------------------------------------------

  describe("consent level", () => {
    /** authorize → expect the consent page; returns its signed query. */
    async function consentPage(
      app: Hono,
      cookie: string,
      extra: Record<string, string>,
    ): Promise<string> {
      const authorize = await app.request(`${BASE}${AUTHORIZE}`, {
        method: "POST",
        headers: { "content-type": FORM, cookie, origin: BASE },
        body: formBody({ resource: CANONICAL, ...extra }),
      });
      expect(authorize.status).toBe(302);
      const location = new URL(authorize.headers.get("location")!, BASE);
      expect(location.pathname).toContain("/mcp-consent");
      return location.search.slice(1);
    }

    function postConsent(
      app: Hono,
      cookie: string,
      body: Record<string, unknown>,
      origin: string = BASE,
    ) {
      return app.request(`${BASE}/api/auth/oauth2/consent`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin },
        body: JSON.stringify(body),
      });
    }

    async function codeFrom(response: Response): Promise<string> {
      expect(response.status).toBe(200);
      const json = (await response.json()) as { redirect: boolean; url: string };
      expect(json.redirect).toBe(true);
      const code = new URL(json.url).searchParams.get("code");
      expect(code).toBeTruthy();
      return code ?? "";
    }

    async function exchange(app: Hono, code: string): Promise<Record<string, unknown>> {
      const token = await app.request(`${BASE}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": FORM },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: CLIENT,
          code,
          code_verifier: VERIFIER,
          redirect_uri: CALLBACK,
        }),
      });
      expect(token.status).toBe(200);
      const json = (await token.json()) as { access_token: string };
      return JSON.parse(
        Buffer.from(json.access_token.split(".")[1] ?? "", "base64url").toString("utf8"),
      ) as Record<string, unknown>;
    }

    it("a person choosing Full records a Full grant (audited as the person) the code exchanges into", async () => {
      const { app, auth } = buildApp({ skipConsent: false });
      const cookie = await consentFixtureUser(app, auth, "full@example.test");
      const query = await consentPage(app, cookie, { scope: "mcp:read mcp:write" });
      const code = await codeFrom(
        await postConsent(app, cookie, { accept: true, level: "FULL", oauth_query: query }),
      );
      expect(store.rows).toHaveLength(1);
      expect(store.rows[0]?.level).toBe("FULL");
      expect(store.audits).toEqual([
        expect.objectContaining({
          actor: "USER",
          action: "mcp_grant.consent",
          resourceType: "mcp_grant",
          resourceId: store.rows[0]?.id,
          after: { level: "FULL" },
        }),
      ]);
      const claims = await exchange(app, code);
      expect(claims.mcp_grant_id).toBe(store.rows[0]?.id);
      expect(claims.scope).toBe("mcp:read mcp:write");
    });

    it("no level in the approval means Read-only, even when the client asked for mcp:write", async () => {
      const { app, auth } = buildApp({ skipConsent: false });
      const cookie = await consentFixtureUser(app, auth, "default@example.test");
      const query = await consentPage(app, cookie, { scope: "mcp:read mcp:write" });
      await codeFrom(await postConsent(app, cookie, { accept: true, oauth_query: query }));
      expect(store.rows[0]?.level).toBe("READ");
    });

    it("a client cannot pick the level: a `level` it puts in the authorize request is never read", async () => {
      const { app, auth } = buildApp({ skipConsent: false });
      const cookie = await consentFixtureUser(app, auth, "client-level@example.test");
      const query = await consentPage(app, cookie, {
        scope: "mcp:read mcp:write",
        level: "FULL",
      });
      // The client's parameter rides inside the signed query; the approval carries none.
      expect(new URLSearchParams(query).get("level")).toBe("FULL");
      await codeFrom(await postConsent(app, cookie, { accept: true, oauth_query: query }));
      expect(store.rows[0]?.level).toBe("READ");
    });

    it("refuses Full when the approved scopes lack mcp:write, and an unknown level, before any code or grant", async () => {
      const { app, auth, memory } = buildApp({ skipConsent: false });
      const cookie = await consentFixtureUser(app, auth, "refused@example.test");
      const readOnly = await consentPage(app, cookie, { scope: "mcp:read" });
      const full = await postConsent(app, cookie, {
        accept: true,
        level: "FULL",
        oauth_query: readOnly,
      });
      expect(full.status).toBe(400);
      expect(await full.json()).toMatchObject({ error: "invalid_request" });
      // Narrowing the approval to mcp:read takes write away too.
      const both = await consentPage(app, cookie, { scope: "mcp:read mcp:write" });
      const narrowed = await postConsent(app, cookie, {
        accept: true,
        level: "FULL",
        scope: "mcp:read",
        oauth_query: both,
      });
      expect(narrowed.status).toBe(400);
      const unknown = await postConsent(app, cookie, {
        accept: true,
        level: "ADMIN",
        oauth_query: both,
      });
      expect(unknown.status).toBe(400);
      expect(store.rows).toHaveLength(0);
      expect(memory.oauthConsent ?? []).toHaveLength(0);
    });

    it("a cross-site approval (another origin) is refused before any level is written", async () => {
      const { app, auth } = buildApp({ skipConsent: false, originCheck: true });
      const cookie = await consentFixtureUser(app, auth, "csrf@example.test");
      const query = await consentPage(app, cookie, { scope: "mcp:read mcp:write" });
      const forged = await postConsent(
        app,
        cookie,
        { accept: true, level: "FULL", oauth_query: query },
        "https://evil.example",
      );
      expect(forged.status).toBe(403);
      expect(store.rows).toHaveLength(0);
      // The same approval from the app's own origin goes through.
      await codeFrom(
        await postConsent(app, cookie, { accept: true, level: "FULL", oauth_query: query }),
      );
      expect(store.rows[0]?.level).toBe("FULL");
    });

    it("step-up: the person's choice on the re-prompt replaces the level; remembered consent never changes it", async () => {
      const lowered: McpGrantLevelLoweredEvent[] = [];
      const unsubscribe = onMcpGrantLevelLowered((event) => {
        lowered.push(event);
      });
      try {
        const { app, auth } = buildApp({ skipConsent: false });
        const cookie = await consentFixtureUser(app, auth, "stepup-level@example.test");
        // First approval: read only.
        await codeFrom(
          await postConsent(app, cookie, {
            accept: true,
            oauth_query: await consentPage(app, cookie, { scope: "mcp:read" }),
          }),
        );
        expect(store.rows[0]?.level).toBe("READ");

        // Step-up to mcp:write re-prompts; the person chooses Full.
        await codeFrom(
          await postConsent(app, cookie, {
            accept: true,
            level: "FULL",
            oauth_query: await consentPage(app, cookie, { scope: "mcp:read mcp:write" }),
          }),
        );
        expect(store.rows).toHaveLength(1);
        expect(store.rows[0]?.level).toBe("FULL");

        // The person lowers it elsewhere (Access → Agents); a remembered
        // re-authorization (no page) issues a code but never raises it back.
        const row = store.rows[0];
        if (row) row.level = "READ";
        const remembered = await app.request(`${BASE}${AUTHORIZE}`, {
          method: "POST",
          headers: { "content-type": FORM, cookie, origin: BASE },
          body: formBody({ scope: "mcp:read mcp:write", resource: CANONICAL }),
        });
        expect(remembered.status).toBe(302);
        const code = new URL(remembered.headers.get("location")!).searchParams.get("code");
        expect(code).toBeTruthy();
        await exchange(app, code ?? "");
        expect(store.rows[0]?.level).toBe("READ");

        // prompt=consent shows the page again: the person raises, then lowers.
        await codeFrom(
          await postConsent(app, cookie, {
            accept: true,
            level: "FULL",
            oauth_query: await consentPage(app, cookie, {
              scope: "mcp:read mcp:write",
              prompt: "consent",
            }),
          }),
        );
        expect(store.rows[0]?.level).toBe("FULL");
        expect(lowered).toEqual([]);
        await codeFrom(
          await postConsent(app, cookie, {
            accept: true,
            level: "READ",
            oauth_query: await consentPage(app, cookie, {
              scope: "mcp:read mcp:write",
              prompt: "consent",
            }),
          }),
        );
        expect(store.rows[0]?.level).toBe("READ");
        expect(lowered).toEqual([{ userId: store.rows[0]?.userId, grantId: store.rows[0]?.id }]);
        expect(store.audits.map((entry) => (entry as { after: unknown }).after)).toEqual([
          { level: "READ" },
          { level: "FULL" },
          { level: "FULL" },
          { level: "READ" },
        ]);
      } finally {
        unsubscribe();
      }
    });

    it("withholds the code when the level cannot be recorded", async () => {
      const { app, auth, memory } = buildApp({ skipConsent: false });
      const cookie = await consentFixtureUser(app, auth, "storage@example.test");
      const query = await consentPage(app, cookie, { scope: "mcp:read mcp:write" });
      grants.createMany.mockRejectedValueOnce(new Error("db down"));
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const response = await postConsent(app, cookie, {
          accept: true,
          level: "FULL",
          oauth_query: query,
        });
        expect(response.status).toBe(500);
        const text = await response.text();
        expect(text).not.toContain("code=");
        // The approval is forgotten: the next authorize asks the person again instead of
        // issuing a code from a remembered consent.
        expect(memory.oauthConsent ?? []).toHaveLength(0);
        await consentPage(app, cookie, { scope: "mcp:read mcp:write" });
      } finally {
        errors.mockRestore();
      }
    });
  });
});
