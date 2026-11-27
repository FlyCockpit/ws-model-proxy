import { createHash, createPublicKey, verify, type webcrypto } from "node:crypto";
import {
  ALL_AGENT_SCOPES,
  agentScopeToDb,
  MCP_FINE_SCOPES,
  MCP_MISSING_SCOPE_DESCRIPTION,
} from "@ws-model-proxy/auth/agent-scopes";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { makeSignature } from "better-auth/crypto";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const FULL_OAUTH_SCOPE = `mcp:read ${MCP_FINE_SCOPES.join(" ")}`;

/**
 * Committed real-handler parity tests (Part D pass 3, L21): the authorize
 * boundary in mcp-authorize-scope-guard.ts must judge exactly the request
 * the INSTALLED downstream stack (better-auth@1.7.18 → better-call@1.4.5
 * getBody + oauth-provider query parsing) would judge. Every fixture here
 * mounts the guard in front of a real `betterAuth` instance (memory
 * adapter, real resolveMcpPlugins with the flag on, mocked Prisma mcpGrant
 * table) and asserts the PINNED downstream semantics end to end.
 *
 * Coverage split (pass 4): the skipConsent: true fixtures below cover
 * PARSER parity (guard vs installed better-call/oauth-provider parsing);
 * the consent-enabled fixture at the bottom covers the full consent flow
 * (authorize → consent page → consent accept → code exchange → grant
 * minting) and the L17 referenceId continuity (consent row referenceId ===
 * the grant's referenceId), and the consent page's Read-only/Full choice
 * (mcp-consent-access.ts): only the person's approval sets grant access.
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
  scopes: ReturnType<typeof agentScopeToDb>[];
  allNodes: boolean;
  Nodes: { nodeId: string }[];
  revokedAt: Date | null;
};
type GrantKey = { userId: string; clientId: string; referenceId: string };
const store = vi.hoisted(() => ({
  rows: [] as GrantRow[],
  audits: [] as unknown[],
  memory: {} as Record<string, Record<string, unknown>[]>,
}));
const grants = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
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
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => [{ acquired: true }]),
    session: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; userId: string; expiresAt: { gt: Date } } }) =>
          store.memory.session?.find(
            (row) =>
              row.id === where.id &&
              row.userId === where.userId &&
              row.expiresAt instanceof Date &&
              row.expiresAt > where.expiresAt.gt,
          ) ?? null,
      ),
    },
    mcpGrant: grants,
    auditEvent: audits,
    mcpGrantNode: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async () => ({ count: 0 })),
    },
  };
  return {
    default: {
      ...tx,
      $transaction: (run: (client: typeof tx) => Promise<unknown>) => run(tx),
    },
  };
});

import {
  type AgentAccessNarrowedEvent,
  onMcpGrantAccessNarrowed,
} from "../../../packages/auth/src/mcp-grant-access";
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

function createRow(
  data: GrantKey & { scopes?: ReturnType<typeof agentScopeToDb>[]; allNodes?: boolean },
): GrantRow {
  const row: GrantRow = {
    id: `parity-grant-${store.rows.length + 1}`,
    userId: data.userId,
    clientId: data.clientId,
    referenceId: data.referenceId,
    scopes: data.scopes ?? ["READ"],
    allNodes: data.allNodes ?? true,
    Nodes: [],
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
    .mockImplementation(
      async (args: {
        data: Array<GrantKey & { scopes: ReturnType<typeof agentScopeToDb>[]; allNodes: boolean }>;
      }) => {
        let count = 0;
        for (const data of args.data) {
          if (findRow(data)) continue;
          createRow(data);
          count += 1;
        }
        return { count };
      },
    );
  grants.findFirst
    .mockReset()
    .mockImplementation(async (args: { where: { id: string; userId?: string } }) => {
      const row = store.rows.find(
        (candidate) =>
          candidate.id === args.where.id &&
          (args.where.userId === undefined || candidate.userId === args.where.userId) &&
          candidate.revokedAt === null,
      );
      return row ? { ...row } : null;
    });
  grants.updateMany.mockReset().mockImplementation(
    async (args: {
      where: {
        id: string;
        userId: string;
        scopes: { equals: ReturnType<typeof agentScopeToDb>[] };
        allNodes: boolean;
      };
      data: { scopes: ReturnType<typeof agentScopeToDb>[]; allNodes: boolean };
    }) => {
      const row = store.rows.find(
        (candidate) =>
          candidate.id === args.where.id &&
          candidate.userId === args.where.userId &&
          candidate.revokedAt === null &&
          JSON.stringify(candidate.scopes) === JSON.stringify(args.where.scopes.equals) &&
          candidate.allNodes === args.where.allNodes,
      );
      if (!row) return { count: 0 };
      row.scopes = args.data.scopes;
      row.allNodes = args.data.allNodes;
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
        scopes: ["mcp:read", ...MCP_FINE_SCOPES, "offline_access"],
        skipConsent,
        requirePKCE: true,
        disabled: false,
      },
    ],
  };
  // Production auth and the mint fence use the same durable session table.
  // Reuse the rows created by real sign-up instead of inventing a live session.
  store.memory = memory;
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

  it.each([
    { ...oauthParams, resource: CANONICAL },
    { ...oauthParams, scope: "   ", resource: CANONICAL },
    { ...oauthParams, scope: "mcp:read" },
    { ...oauthParams, scope: "mcp:read", resource: CANONICAL },
  ])(
    "hybrid JSON/form content type → downstream 415 before OAuth validation (%j)",
    async (payload) => {
      const { app } = buildApp();
      const res = await app.request(`${BASE}${AUTHORIZE}`, {
        method: "POST",
        headers: { "content-type": HYBRID_JSON, origin: BASE },
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(415);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.json()).toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });
      expect(grants.findUnique).not.toHaveBeenCalled();
      expect(grants.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    "application/x-www-form-urlencoded+json",
    "application/vnd.x+json+application/x-www-form-urlencoded",
    "text/application/x-www-form-urlencoded",
    "application/x-www-form-urlencoded-json",
  ])("non-exact form media type %s → downstream 415", async (contentType) => {
    const { app } = buildApp();
    const res = await app.request(`${BASE}${AUTHORIZE}`, {
      method: "POST",
      headers: { "content-type": contentType, origin: BASE },
      body: formBody({ scope: "mcp:read", resource: CANONICAL }),
    });
    expect(res.status).toBe(415);
    expect(res.headers.get("location")).toBeNull();
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
    query.append("scope", "mcp:pools");
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
    expect(store.rows[0]?.scopes).toEqual(["READ"]);
  });

  it.each([
    ["deleted", 400],
    ["expired", 400],
    ["another owner", 401],
  ] as const)(
    "refuses code exchange when the authorizing session is %s, even if another session is live",
    async (state, status) => {
      const { app, auth, memory } = buildApp();
      const signup = await auth.api.signUpEmail({
        body: {
          name: "Parity",
          email: "parity@example.test",
          password: "parity-test-password-123",
        },
        asResponse: true,
      });
      expect(signup.status).toBe(200);
      const cookie = signup.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      const authorize = await app.request(`${BASE}${AUTHORIZE}`, {
        method: "POST",
        headers: { "content-type": FORM, cookie, origin: BASE },
        body: formBody({ scope: "mcp:read offline_access", resource: CANONICAL }),
      });
      expect(authorize.status).toBe(302);
      const code = new URL(authorize.headers.get("location")!, BASE).searchParams.get("code");
      expect(code).toBeTruthy();
      const sessions = memory.session;
      const session = sessions?.[0];
      if (!sessions || !session) throw new Error("Sign-up did not persist a session");
      // A sibling session must never authorize a code issued to this session.
      sessions.push({ ...session, id: "other-session", token: "other-session-token" });
      if (state === "deleted") memory.session = sessions.filter((row) => row !== session);
      else if (state === "expired") session.expiresAt = new Date(0);
      else session.userId = "another-owner";

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
      // The provider rejects absent/expired sessions; the mint fence also checks ownership.
      expect(token.status).toBe(status);
      expect(await token.json()).not.toHaveProperty("access_token");
      expect(grants.create).not.toHaveBeenCalled();
      expect(store.rows).toHaveLength(0);
    },
  );

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

    // 5. The approval created the grant (with the default read scope)
    //    under the CONSENT row's referenceId (L17 continuity), before the
    //    code reached the browser.
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      referenceId: consentRow?.referenceId,
      clientId: CLIENT,
      scopes: ["READ"],
      allNodes: true,
      Nodes: [],
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

    // Step-up request adds all fine scopes: the remembered row does NOT cover the
    // requested scope set (`!requestedScopes.every((s) => consent.scopes
    // .includes(s))` in the installed authorize), so the consent page
    // re-prompts — for the FULL requested scope set (mcp:read all fine scopes),
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
      body: formBody({ scope: FULL_OAUTH_SCOPE, resource: CANONICAL }),
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
    expect(scopeSets.some((scopes) => scopes.includes("mcp:pools"))).toBe(true);

    // A subsequent FULL-SET authorize now skips the prompt (the remembered
    // set covers it).
    const after = await app.request(`${BASE}${AUTHORIZE}`, {
      method: "POST",
      headers: { "content-type": FORM, cookie, origin: BASE },
      body: formBody({ scope: FULL_OAUTH_SCOPE, resource: CANONICAL }),
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
  // The consent page's scope choice: access
  // comes from the PERSON's consent body only, defaults to read,
  // and is recorded on the exact grant the code exchanges into.
  // ------------------------------------------------------------------

  describe("consent access", () => {
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
      const query = await consentPage(app, cookie, { scope: FULL_OAUTH_SCOPE });
      const code = await codeFrom(
        await postConsent(app, cookie, {
          accept: true,
          scopes: ALL_AGENT_SCOPES,
          nodeIds: null,
          oauth_query: query,
        }),
      );
      expect(store.rows).toHaveLength(1);
      expect(store.rows[0]?.scopes).toEqual(ALL_AGENT_SCOPES.map(agentScopeToDb));
      expect(store.audits).toEqual([
        expect.objectContaining({
          actor: "USER",
          action: "mcp_grant.consent",
          resourceType: "mcp_grant",
          resourceId: store.rows[0]?.id,
          after: { scopes: ALL_AGENT_SCOPES, nodeIds: null },
        }),
      ]);
      const claims = await exchange(app, code);
      expect(claims.mcp_grant_id).toBe(store.rows[0]?.id);
      expect(claims.scope).toBe(FULL_OAUTH_SCOPE);
    });

    it("no scopes in the approval means Read-only, even when the client asked for all fine scopes", async () => {
      const { app, auth } = buildApp({ skipConsent: false });
      const cookie = await consentFixtureUser(app, auth, "default@example.test");
      const query = await consentPage(app, cookie, { scope: FULL_OAUTH_SCOPE });
      await codeFrom(await postConsent(app, cookie, { accept: true, oauth_query: query }));
      expect(store.rows[0]?.scopes).toEqual(["READ"]);
    });

    it("a client cannot pick grant scopes: `scopes` it puts in the authorize request is never read", async () => {
      const { app, auth } = buildApp({ skipConsent: false });
      const cookie = await consentFixtureUser(app, auth, "client-level@example.test");
      const query = await consentPage(app, cookie, {
        scope: FULL_OAUTH_SCOPE,
        scopes: JSON.stringify(ALL_AGENT_SCOPES),
      });
      // The client's parameter rides inside the signed query; the approval carries none.
      expect(new URLSearchParams(query).get("scopes")).toBe(JSON.stringify(ALL_AGENT_SCOPES));
      await codeFrom(await postConsent(app, cookie, { accept: true, oauth_query: query }));
      expect(store.rows[0]?.scopes).toEqual(["READ"]);
    });

    it("refuses Full when the approved scopes lack all fine scopes, and an unknown scope, before any code or grant", async () => {
      const { app, auth, memory } = buildApp({ skipConsent: false });
      const cookie = await consentFixtureUser(app, auth, "refused@example.test");
      const readOnly = await consentPage(app, cookie, { scope: "mcp:read" });
      const full = await postConsent(app, cookie, {
        accept: true,
        scopes: ALL_AGENT_SCOPES,
        nodeIds: null,
        oauth_query: readOnly,
      });
      expect(full.status).toBe(400);
      expect(await full.json()).toMatchObject({ error: "invalid_request" });
      // Narrowing the approval to mcp:read takes write away too.
      const both = await consentPage(app, cookie, { scope: FULL_OAUTH_SCOPE });
      const narrowed = await postConsent(app, cookie, {
        accept: true,
        scopes: ALL_AGENT_SCOPES,
        nodeIds: null,
        scope: "mcp:read",
        oauth_query: both,
      });
      expect(narrowed.status).toBe(400);
      const unknown = await postConsent(app, cookie, {
        accept: true,
        scopes: ["read", "admin"],
        oauth_query: both,
      });
      expect(unknown.status).toBe(400);
      expect(store.rows).toHaveLength(0);
      expect(memory.oauthConsent ?? []).toHaveLength(0);
    });

    it("a cross-site approval (another origin) is refused before any access is written", async () => {
      const { app, auth } = buildApp({ skipConsent: false, originCheck: true });
      const cookie = await consentFixtureUser(app, auth, "csrf@example.test");
      const query = await consentPage(app, cookie, { scope: FULL_OAUTH_SCOPE });
      const forged = await postConsent(
        app,
        cookie,
        { accept: true, scopes: ALL_AGENT_SCOPES, nodeIds: null, oauth_query: query },
        "https://evil.example",
      );
      expect(forged.status).toBe(403);
      expect(store.rows).toHaveLength(0);
      // The same approval from the app's own origin goes through.
      await codeFrom(
        await postConsent(app, cookie, {
          accept: true,
          scopes: ALL_AGENT_SCOPES,
          nodeIds: null,
          oauth_query: query,
        }),
      );
      expect(store.rows[0]?.scopes).toEqual(ALL_AGENT_SCOPES.map(agentScopeToDb));
    });

    it("step-up: the person's choice on the re-prompt replaces access; remembered consent never changes it", async () => {
      const lowered: AgentAccessNarrowedEvent[] = [];
      const unsubscribe = onMcpGrantAccessNarrowed((event) => {
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
        expect(store.rows[0]?.scopes).toEqual(["READ"]);

        // Step-up to all fine scopes re-prompts; the person chooses Full.
        await codeFrom(
          await postConsent(app, cookie, {
            accept: true,
            scopes: ALL_AGENT_SCOPES,
            nodeIds: null,
            oauth_query: await consentPage(app, cookie, { scope: FULL_OAUTH_SCOPE }),
          }),
        );
        expect(store.rows).toHaveLength(1);
        expect(store.rows[0]?.scopes).toEqual(ALL_AGENT_SCOPES.map(agentScopeToDb));

        // The person lowers it elsewhere (Access → Agents); a remembered
        // re-authorization (no page) issues a code but never raises it back.
        const row = store.rows[0];
        if (row) row.scopes = ["READ"];
        const remembered = await app.request(`${BASE}${AUTHORIZE}`, {
          method: "POST",
          headers: { "content-type": FORM, cookie, origin: BASE },
          body: formBody({ scope: FULL_OAUTH_SCOPE, resource: CANONICAL }),
        });
        expect(remembered.status).toBe(302);
        const code = new URL(remembered.headers.get("location")!).searchParams.get("code");
        expect(code).toBeTruthy();
        await exchange(app, code ?? "");
        expect(store.rows[0]?.scopes).toEqual(["READ"]);

        // prompt=consent shows the page again: the person raises, then lowers.
        await codeFrom(
          await postConsent(app, cookie, {
            accept: true,
            scopes: ALL_AGENT_SCOPES,
            nodeIds: null,
            oauth_query: await consentPage(app, cookie, {
              scope: FULL_OAUTH_SCOPE,
              prompt: "consent",
            }),
          }),
        );
        expect(store.rows[0]?.scopes).toEqual(ALL_AGENT_SCOPES.map(agentScopeToDb));
        expect(lowered).toEqual([]);
        await codeFrom(
          await postConsent(app, cookie, {
            accept: true,
            scopes: ["read"],
            nodeIds: null,
            oauth_query: await consentPage(app, cookie, {
              scope: FULL_OAUTH_SCOPE,
              prompt: "consent",
            }),
          }),
        );
        expect(store.rows[0]?.scopes).toEqual(["READ"]);
        expect(lowered).toEqual([
          {
            kind: "oauth_grant",
            agentTokenId: null,
            userId: store.rows[0]?.userId,
            grantId: store.rows[0]?.id,
            before: { scopes: ALL_AGENT_SCOPES, nodeIds: null },
            after: { scopes: ["read"], nodeIds: null },
          },
        ]);
        expect(store.audits.map((entry) => (entry as { after: unknown }).after)).toEqual([
          { scopes: ["read"], nodeIds: null },
          { scopes: ALL_AGENT_SCOPES, nodeIds: null },
          { scopes: ALL_AGENT_SCOPES, nodeIds: null },
          { scopes: ["read"], nodeIds: null },
        ]);
      } finally {
        unsubscribe();
      }
    });

    it("withholds the code when access cannot be recorded", async () => {
      const { app, auth, memory } = buildApp({ skipConsent: false });
      const cookie = await consentFixtureUser(app, auth, "storage@example.test");
      const query = await consentPage(app, cookie, { scope: FULL_OAUTH_SCOPE });
      grants.createMany.mockRejectedValueOnce(new Error("db down"));
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const response = await postConsent(app, cookie, {
          accept: true,
          scopes: ALL_AGENT_SCOPES,
          nodeIds: null,
          oauth_query: query,
        });
        expect(response.status).toBe(500);
        const text = await response.text();
        expect(text).not.toContain("code=");
        // The approval is forgotten: the next authorize asks the person again instead of
        // issuing a code from a remembered consent.
        expect(memory.oauthConsent ?? []).toHaveLength(0);
        await consentPage(app, cookie, { scope: FULL_OAUTH_SCOPE });
      } finally {
        errors.mockRestore();
      }
    });
  });
});

// ------------------------------------------------------------------
// better-auth#12194 (open upstream; fix PR #12231 unmerged): oauth-provider 1.7.18 answers an
// authorize request without `scope` with every scope stored on the client. The parity client,
// like a DCR client registered without `scope`, stores the whole ceiling (mcp:read, the six
// fine scopes, offline_access). These cases show what wsmp issues for a scopeless or partial
// request: tokens are verified against the provider's own JWKS, not just decoded.
// ------------------------------------------------------------------
describe("better-auth#12194: scopeless and partial authorize requests never widen", () => {
  async function signedIn(auth: ReturnType<typeof buildApp>["auth"], email: string) {
    const signup = await auth.api.signUpEmail({
      body: { name: "Scope Check", email, password: "parity-test-password-123" },
      asResponse: true,
    });
    expect(signup.status).toBe(200);
    return signup.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
  }

  /** The JWT's claims after checking its signature against the provider's published JWKS. */
  async function verifiedClaims(
    auth: ReturnType<typeof buildApp>["auth"],
    jwt: string,
  ): Promise<Record<string, unknown>> {
    const [header = "", payload = "", signature = ""] = jwt.split(".");
    const head = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as {
      alg: string;
      kid: string;
    };
    const jwksResponse = await auth.handler(new Request(`${BASE}/api/auth/jwks`));
    expect(jwksResponse.status).toBe(200);
    const { keys } = (await jwksResponse.json()) as {
      keys: (webcrypto.JsonWebKey & { kid: string })[];
    };
    const jwk = keys.find((key) => key.kid === head.kid);
    expect(jwk).toBeDefined();
    const key = createPublicKey({ key: jwk as webcrypto.JsonWebKey, format: "jwk" });
    const check = (body: string) =>
      head.alg === "EdDSA"
        ? verify(null, Buffer.from(body), key, Buffer.from(signature, "base64url"))
        : verify(
            "sha256",
            Buffer.from(body),
            { key, dsaEncoding: "ieee-p1363" },
            Buffer.from(signature, "base64url"),
          );
    expect(check(`${header}.${payload}`)).toBe(true);
    // Control: the same check refuses a payload with a widened scope.
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
        scope: FULL_OAUTH_SCOPE,
      }),
    ).toString("base64url");
    expect(check(`${header}.${forged}`)).toBe(false);
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  }

  function expectMissingScope(response: Response) {
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
  }

  it.each([
    ["GET", undefined],
    ["GET", ""],
    ["GET", " \t "],
    ["POST", undefined],
    ["POST", ""],
  ])(
    "through the server: %s with scope %j → local invalid_scope, nothing stored",
    async (method, scope) => {
      const { app, auth, memory } = buildApp({ skipConsent: false });
      const cookie = await signedIn(auth, "guard@example.test");
      const params = {
        ...oauthParams,
        resource: CANONICAL,
        ...(scope === undefined ? {} : { scope }),
      };
      const response =
        method === "GET"
          ? await app.request(`${BASE}${AUTHORIZE}?${new URLSearchParams(params)}`, {
              headers: { cookie },
            })
          : await app.request(`${BASE}${AUTHORIZE}`, {
              method: "POST",
              headers: { "content-type": FORM, cookie, origin: BASE },
              body: new URLSearchParams(params).toString(),
            });
      expectMissingScope(response);
      expect(await response.json()).toEqual({
        error: "invalid_scope",
        error_description: MCP_MISSING_SCOPE_DESCRIPTION,
      });
      expect(memory.verification).toHaveLength(0);
      expect(memory.oauthConsent).toHaveLength(0);
      expect(store.rows).toHaveLength(0);
    },
  );

  it.each(["GET", "POST"])(
    "at the provider, without the server's guard: %s without scope → invalid_scope, not the stored ceiling",
    async (method) => {
      const { auth, memory } = buildApp({ skipConsent: false });
      const cookie = await signedIn(auth, "direct@example.test");
      const params = new URLSearchParams({ ...oauthParams, resource: CANONICAL });
      const response = await auth.handler(
        method === "GET"
          ? new Request(`${BASE}${AUTHORIZE}?${params}`, { headers: { cookie } })
          : new Request(`${BASE}${AUTHORIZE}`, {
              method: "POST",
              headers: { "content-type": FORM, cookie, origin: BASE },
              body: params.toString(),
            }),
      );
      expectMissingScope(response);
      expect(await response.json()).toMatchObject({
        error: "invalid_scope",
        error_description: MCP_MISSING_SCOPE_DESCRIPTION,
      });
      expect(memory.verification).toHaveLength(0);
      expect(memory.oauthConsent).toHaveLength(0);
    },
  );

  it.each([
    ["consent", { accept: true }],
    ["continue", { selected: true }],
    ["continue", { postLogin: true }],
  ])("a signed query without scope cannot resume through %s %j", async (path, body) => {
    const { app, auth, memory } = buildApp({ skipConsent: false });
    const cookie = await signedIn(auth, "resume@example.test");
    const query = new URLSearchParams({
      ...oauthParams,
      resource: CANONICAL,
      exp: String(Math.floor(Date.now() / 1000) + 600),
    });
    query.sort();
    query.set(
      "sig",
      await makeSignature(query.toString(), "parity-test-secret-at-least-thirty-two-characters"),
    );
    const response = await app.request(`${BASE}/api/auth/oauth2/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: BASE },
      body: JSON.stringify({ ...body, oauth_query: query.toString() }),
    });
    expectMissingScope(response);
    expect(await response.json()).toMatchObject({
      error: "invalid_scope",
      error_description: MCP_MISSING_SCOPE_DESCRIPTION,
    });
    expect(memory.oauthConsent).toHaveLength(0);
    expect(memory.verification).toHaveLength(0);
    expect(store.rows).toHaveLength(0);
  });

  it.each([
    [null, 400],
    ["mcp:read", 200],
  ] as const)("sign-in resuming a signed query with scope %j answers %i", async (scope, status) => {
    const { app, auth, memory } = buildApp({ skipConsent: false });
    await signedIn(auth, "signin@example.test");
    const sessions = memory.session?.length ?? 0;
    const query = new URLSearchParams({
      ...oauthParams,
      resource: CANONICAL,
      ...(scope === null ? {} : { scope }),
      exp: String(Math.floor(Date.now() / 1000) + 600),
    });
    query.sort();
    query.set(
      "sig",
      await makeSignature(query.toString(), "parity-test-secret-at-least-thirty-two-characters"),
    );
    const response = await app.request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({
        email: "signin@example.test",
        password: "parity-test-password-123",
        oauth_query: query.toString(),
      }),
    });
    expect(response.status).toBe(status);
    if (scope === null) {
      expect(await response.json()).toMatchObject({
        error: "invalid_scope",
        error_description: MCP_MISSING_SCOPE_DESCRIPTION,
      });
      expect(memory.session).toHaveLength(sessions);
      return;
    }
    // The resumed authorize goes on to consent with exactly the signed scope.
    const body = (await response.json()) as { url?: string };
    const next = new URL(body.url ?? "", BASE);
    expect(next.pathname).toContain("/mcp-consent");
    expect(next.searchParams.get("scope")).toBe(scope);
  });

  it.each([
    ["mcp:read", ["read"]],
    ["mcp:read offline_access", ["read"]],
    ["mcp:read mcp:files offline_access", ["read", "files"]],
  ] as const)(
    "a client holding every scope that asks for %j gets a token for exactly that",
    async (scope, agentScopes) => {
      const { app, auth, memory } = buildApp({ skipConsent: false });
      const cookie = await signedIn(auth, "partial@example.test");
      expect(memory.oauthClient?.[0]?.scopes).toEqual([
        "mcp:read",
        ...MCP_FINE_SCOPES,
        "offline_access",
      ]);
      const authorize = await app.request(`${BASE}${AUTHORIZE}`, {
        method: "POST",
        headers: { "content-type": FORM, cookie, origin: BASE },
        body: formBody({ scope, resource: CANONICAL }),
      });
      expect(authorize.status).toBe(302);
      const page = new URL(authorize.headers.get("location")!, BASE);
      expect(page.pathname).toContain("/mcp-consent");
      // The consent page is asked about exactly the requested scopes.
      expect(page.searchParams.get("scope")).toBe(scope);
      const oauthQuery = page.search.slice(1);
      const consent = (extra: Record<string, unknown>) =>
        app.request(`${BASE}/api/auth/oauth2/consent`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie, origin: BASE },
          body: JSON.stringify({ accept: true, oauth_query: oauthQuery, ...extra }),
        });

      // Approval cannot widen: neither the OAuth scope nor the agent permissions.
      const widerScope = await consent({ scope: `${scope} mcp:pools` });
      expect(widerScope.status).toBe(400);
      const widerAccess = await consent({ scopes: [...agentScopes, "pools"] });
      expect(widerAccess.status).toBe(400);
      expect(await widerAccess.json()).toMatchObject({
        error_description: "Agent scopes exceed the approved OAuth scopes.",
      });
      expect(memory.oauthConsent).toHaveLength(0);
      expect(store.rows).toHaveLength(0);

      const approved = await consent({ scopes: [...agentScopes] });
      expect(approved.status).toBe(200);
      const { url } = (await approved.json()) as { url: string };
      const code = new URL(url, BASE).searchParams.get("code");
      expect(code).toBeTruthy();
      expect(store.rows).toHaveLength(1);
      expect(store.rows[0]?.scopes).toEqual(agentScopes.map(agentScopeToDb));

      const token = await app.request(`${BASE}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": FORM },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: CLIENT,
          code: code!,
          code_verifier: VERIFIER,
          redirect_uri: CALLBACK,
          // Ignored on a code exchange: the code carries the consented scopes.
          scope: FULL_OAUTH_SCOPE,
        }),
      });
      expect(token.status).toBe(200);
      const tokens = (await token.json()) as {
        access_token: string;
        refresh_token?: string;
        scope: string;
      };
      expect(tokens.scope).toBe(scope);
      const claims = await verifiedClaims(auth, tokens.access_token);
      expect(claims.scope).toBe(scope);
      expect(claims.aud).toBe(CANONICAL);
      expect(claims.mcp_grant_id).toBe(store.rows[0]?.id);

      if (!scope.includes("offline_access")) {
        expect(tokens.refresh_token).toBeUndefined();
        return;
      }
      const refresh = (extra: Record<string, string>) =>
        app.request(`${BASE}/api/auth/oauth2/token`, {
          method: "POST",
          headers: { "content-type": FORM },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: CLIENT,
            refresh_token: tokens.refresh_token ?? "",
            ...extra,
          }),
        });
      // A refresh cannot add a scope the person did not approve.
      const widened = await refresh({ scope: `${scope} mcp:pools` });
      expect(widened.status).toBe(400);
      expect(await widened.json()).toMatchObject({ error: "invalid_scope" });
      // A refresh without scope keeps exactly the approved scopes.
      const kept = await refresh({});
      expect(kept.status).toBe(200);
      const keptJson = (await kept.json()) as { access_token: string; scope: string };
      expect(keptJson.scope).toBe(scope);
      expect((await verifiedClaims(auth, keptJson.access_token)).scope).toBe(scope);
    },
  );
});
