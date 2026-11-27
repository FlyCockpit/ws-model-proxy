import { createHash } from "node:crypto";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthMiddleware } from "better-auth/api";
import { afterEach, expect, it, vi } from "vitest";

// Real installed OAuth rotation/replay + JWT verification + production MCP admission.
// Only storage and outbound JWKS transport are substituted; no database or network is used.
type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({ memory: {} as Record<string, Row[]>, grants: [] as Row[] }));
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    WMP_MCP_ENABLED: true,
    BETTER_AUTH_URL: "https://proxy.example.test",
    BETTER_AUTH_SECRET: "oauth-reset-test-secret-at-least-thirty-two-characters",
    WMP_RATE_LIMIT_SCALE: 1,
    TRUST_PROXY_HOPS: 0,
  },
}));
vi.mock("@ws-model-proxy/mailer", () => ({ renderResetPassword: vi.fn(), sendEmail: vi.fn() }));
vi.mock("@ws-model-proxy/db", () => {
  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, value]) =>
      key === "OR" && Array.isArray(value)
        ? value.some((condition: Row) => matches(row, condition))
        : value === null
          ? row[key] == null
          : row[key] === value,
    );
  const update = (rows: () => Row[]) => ({
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const selected = rows().filter((row) => matches(row, where));
      for (const row of selected) Object.assign(row, data);
      return { count: selected.length };
    }),
  });
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => [{ acquired: true }]),
    apiKey: update(() => []),
    nodeCredential: update(() => []),
    nodeEnrollmentCode: update(() => []),
    agentToken: update(() => []),
    oauthRefreshToken: update(() => state.memory.oauthRefreshToken ?? []),
    oauthAccessToken: update(() => state.memory.oauthAccessToken ?? []),
    oauthConsent: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    verification: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    user: {
      findUnique: vi.fn(
        async ({ where }: { where: Row }) =>
          state.memory.user?.find((row) => matches(row, where)) ?? null,
      ),
    },
    session: {
      deleteMany: vi.fn(async ({ where }: { where: Row }) => {
        const rows = state.memory.session ?? [];
        state.memory.session = rows.filter((row) => !matches(row, where));
        return { count: rows.length - state.memory.session.length };
      }),
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; userId: string; expiresAt: { gt: Date } } }) =>
          state.memory.session?.find(
            (row) =>
              row.id === where.id &&
              row.userId === where.userId &&
              row.expiresAt instanceof Date &&
              row.expiresAt > where.expiresAt.gt,
          ) ?? null,
      ),
    },
    mcpGrant: {
      ...update(() => state.grants),
      findUnique: vi.fn(
        async ({ where }: { where: { id?: string; userId_clientId_referenceId?: Row } }) =>
          state.grants.find((row) =>
            matches(row, where.userId_clientId_referenceId ?? { id: where.id }),
          ) ?? null,
      ),
      findFirst: vi.fn(
        async ({ where }: { where: Row }) =>
          state.grants.find((row) => matches(row, where)) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = {
          id: "grant-1",
          revokedAt: null,
          scopes: ["READ"],
          allNodes: true,
          Nodes: [],
          ...data,
        };
        state.grants.push(row);
        return row;
      }),
    },
  };
  return {
    default: { ...tx, $transaction: (run: (client: typeof tx) => Promise<unknown>) => run(tx) },
  };
});

import prisma from "@ws-model-proxy/db";
import { resolveMcpPlugins } from "./mcp-plugins";
import { passwordResetOptions } from "./password-reset";
import { secureAccountBeforePasswordReset } from "./password-reset-before";

const BASE = "https://proxy.example.test";
const RESOURCE = `${BASE}/mcp`;
const CLIENT = "reset-client";
const CALLBACK = "https://client.example.test/callback";
const VERIFIER = "reset-pkce-verifier-with-at-least-forty-three-characters";
afterEach(() => vi.restoreAllMocks());

it("a real cached refresh replay still returns its JWT after reset, but MCP refuses that credential", async () => {
  state.grants = [];
  state.memory = {
    user: [],
    account: [],
    session: [],
    verification: [],
    jwks: [],
    oauthAccessToken: [],
    oauthRefreshToken: [],
    oauthConsent: [],
    oauthClientAssertion: [],
    oauthResource: [
      {
        id: "resource",
        identifier: RESOURCE,
        disabled: false,
        allowedScopes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    oauthClientResource: [
      { id: "link", clientId: CLIENT, resourceId: RESOURCE, createdAt: new Date() },
    ],
    oauthClient: [
      {
        id: "client",
        clientId: CLIENT,
        tokenEndpointAuthMethod: "none",
        redirectUris: [CALLBACK],
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        scopes: ["mcp:read", "offline_access"],
        skipConsent: true,
        requirePKCE: true,
        disabled: false,
      },
    ],
  };
  const auth = betterAuth({
    baseURL: BASE,
    secret: "oauth-reset-test-secret-at-least-thirty-two-characters",
    database: memoryAdapter(state.memory),
    emailAndPassword: {
      enabled: true,
      ...passwordResetOptions(false, undefined),
      password: {
        hash: async (password) => `test:${password}`,
        verify: async ({ hash, password }) => hash === `test:${password}`,
      },
    },
    hooks: { before: createAuthMiddleware(secureAccountBeforePasswordReset) },
    plugins: resolveMcpPlugins({ enabled: true, baseUrl: BASE }),
    logger: { disabled: true },
  });
  const signup = await auth.api.signUpEmail({
    body: { name: "Person", email: "reset@example.test", password: "old-password-1" },
    asResponse: true,
  });
  expect(signup.status).toBe(200);
  const cookie = signup.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const authorize = await auth.handler(
    new Request(
      `${BASE}/api/auth/oauth2/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: CLIENT,
        redirect_uri: CALLBACK,
        code_challenge: createHash("sha256").update(VERIFIER).digest("base64url"),
        code_challenge_method: "S256",
        scope: "mcp:read offline_access",
        resource: RESOURCE,
      })}`,
      { headers: { cookie } },
    ),
  );
  expect(authorize.status).toBe(302);
  const code = new URL(authorize.headers.get("location")!, BASE).searchParams.get("code");
  expect(code).toBeTruthy();
  const token = async (body: Record<string, string>) => {
    const response = await auth.handler(
      new Request(`${BASE}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: CLIENT, ...body }),
      }),
    );
    const json = await response.json();
    expect(response.status, JSON.stringify(json)).toBe(200);
    return json as { access_token: string; refresh_token: string };
  };
  const initial = await token({
    grant_type: "authorization_code",
    code: code!,
    code_verifier: VERIFIER,
    redirect_uri: CALLBACK,
  });
  const refreshBody = { grant_type: "refresh_token", refresh_token: initial.refresh_token };
  const rotated = await token(refreshBody);
  const cached = await token(refreshBody);
  expect(cached).toEqual(rotated);
  // Pin that this is the upstream replay path, which skips our claims hook.
  const lookups = vi.mocked(prisma.mcpGrant.findUnique).mock.calls.length;
  expect((await token(refreshBody)).access_token).toBe(cached.access_token);
  expect(vi.mocked(prisma.mcpGrant.findUnique).mock.calls).toHaveLength(lookups);

  const jwks = await auth.handler(new Request(`${BASE}/api/auth/jwks`));
  const keys: unknown = await jwks.json();
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(keys));
  const transport = { fetch: vi.fn(async () => new Response("accepted")) };
  // Load the server boundary at runtime: its sources have their own TypeScript rootDir.
  // This local adapter describes only the HTTP methods the production handler consumes.
  type HttpContext = {
    req: { raw: Request };
    get: () => string;
    header: () => void;
    newResponse: (body: ConstructorParameters<typeof Response>[0], init: ResponseInit) => Response;
  };
  const { createMcpRequestHandler } = await vi.importActual<{
    createMcpRequestHandler: (options: {
      authInstance: typeof auth;
      prisma: typeof prisma;
      transport: typeof transport;
      isForceTwoFactorRequired: () => Promise<boolean>;
      consumeIdentityQuota: () => Promise<{ ok: true }>;
    }) => (context: HttpContext) => Promise<Response>;
  }>("../../../apps/server/src/mcp/auth");
  const handler = createMcpRequestHandler({
    authInstance: auth,
    prisma,
    transport,
    isForceTwoFactorRequired: async () => false,
    consumeIdentityQuota: async () => ({ ok: true }),
  });
  const admit = (credential: string) =>
    handler({
      req: {
        raw: new Request(RESOURCE, {
          method: "POST",
          headers: { authorization: `Bearer ${credential}`, host: new URL(BASE).host },
        }),
      },
      get: () => "reset-test",
      header: () => {},
      newResponse: (body: ConstructorParameters<typeof Response>[0], init: ResponseInit) =>
        new Response(body, init),
    });
  expect((await admit(cached.access_token)).status).toBe(200);
  expect(transport.fetch).toHaveBeenCalledTimes(1);

  const context = await auth.$context;
  await context.internalAdapter.createVerificationValue({
    identifier: "reset-password:recover",
    value: String(state.memory.user?.[0]?.id),
    expiresAt: new Date(Date.now() + 60_000),
  });
  await auth.api.resetPassword({ body: { token: "recover", newPassword: "new-password-1" } });
  const replayAfterReset = await token(refreshBody);
  expect(replayAfterReset.access_token).toBe(cached.access_token);
  expect((await admit(replayAfterReset.access_token)).status).toBe(403);
  expect(transport.fetch).toHaveBeenCalledTimes(1);
}, 30_000);
