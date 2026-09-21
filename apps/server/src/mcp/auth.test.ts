import type { AuthInfo } from "@modelcontextprotocol/server";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * requireMcpAuth DECISION tests (MCP plan Phase 4 item 7). The upstream
 * verifier (`requireMcpAuth` from @better-auth/mcp) is MOCKED: the mock
 * captures the wrapped handler + options and invokes the handler directly
 * with fabricated VERIFIED claims — exactly the seam the real wrapper
 * provides after JWKS/issuer/audience/DPoP/scope verification. Everything
 * DOWNSTREAM of verification (the application-owned admission sequence) is
 * real code under test.
 *
 * Upstream-owned behaviors (JWKS fetch, signature, DPoP, the upstream
 * 401/insufficient-scope challenges) are NOT re-tested here — they are the
 * installed package's own contract, exercised live in the chain tests via
 * the memory-adapter parity instance (no-token 401 challenge).
 */

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    WMP_MCP_ENABLED: true,
    BETTER_AUTH_URL: "https://proxy.example.com",
    BETTER_AUTH_SECRET: "decision-test-secret-at-least-thirty-two-characters",
    CORS_ORIGIN: "https://app.example.com",
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
    RATE_LIMIT_MCP_POINTS: 1000,
    RATE_LIMIT_MCP_DURATION: 60,
    RATE_LIMIT_MCP_CONSENT_POINTS: 2,
    RATE_LIMIT_MCP_CONSENT_DURATION: 60,
    TRUST_PROXY_HOPS: undefined,
  },
}));

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

// Phase 5: createMcpRequestHandler's graph (via handler.ts's default tool
// registration) reaches the API routers, whose mailer chain validates
// @ws-model-proxy/env/shared. Mock it like the other suites do.
vi.mock("@ws-model-proxy/env/shared", () => ({
  env: {
    BETTER_AUTH_SECRET: "decision-test-secret-at-least-thirty-two-characters",
    DATABASE_URL: "postgresql://auth-decision-test",
    NODE_ENV: "test",
  },
}));

const upstreamState = vi.hoisted(() => ({
  claims: {} as Record<string, unknown>,
  capturedOpts: null as Record<string, unknown> | null,
  receivedRequest: null as Request | null,
  failWrapper: null as unknown | null,
  handler: null as
    | ((request: Request, claims: Record<string, unknown>) => Promise<Response>)
    | null,
}));

vi.mock("@better-auth/mcp", async (importOriginal) => {
  // Phase 5: the tool manifest's router graph reaches
  // @ws-model-proxy/auth's plugin chain, which imports the REAL `mcp`
  // plugin factory at module scope (it registers the OAuth provider plugin
  // the auth instance requires). Keep the real factory; only the request
  // verifier is replaced below.
  const actual = await importOriginal<typeof import("@better-auth/mcp")>();
  return {
    ...actual,
    requireMcpAuth: vi.fn(
      (
        _auth: unknown,
        handler: (request: Request, claims: Record<string, unknown>) => Promise<Response>,
        opts: Record<string, unknown>,
      ) => {
        upstreamState.handler = handler;
        upstreamState.capturedOpts = opts;
        return async (req: Request) => {
          if (!upstreamState.handler) throw new Error("handler not captured");
          if (upstreamState.failWrapper !== null) {
            throw upstreamState.failWrapper;
          }
          upstreamState.receivedRequest = req;
          return upstreamState.handler(req, upstreamState.claims);
        };
      },
    ),
  };
});

import { createMcpAdmissionGate } from "./admission";
import {
  createMcpRequestHandler,
  extractPresentedCredential,
  type McpAuthPrisma,
  type McpQuotaResult,
  type McpTransport,
  type McpVerifiedRequest,
  mcpReadBaselineMatcher,
} from "./auth";
import { MCP_SYNTHETIC_SESSION_TOKEN, type McpSessionUser } from "./context";
import { createMcpTransport } from "./handler";

const BASE = "https://proxy.example.com";
const RESOURCE = `${BASE}/mcp`;
const TOKEN = "verified-access-token-value";

const GRANT_ID = "grant-1";
const SUB = "user-1";
const CLIENT_ID = "client-a";

const healthyUser: McpSessionUser = {
  id: SUB,
  name: "Test User",
  email: "test@example.com",
  emailVerified: true,
  image: null,
  createdAt: new Date("2025-01-01T00:00:00Z"),
  updatedAt: new Date("2025-01-01T00:00:00Z"),
  slug: "test-user-slug",
  role: "user",
  locale: "en-US",
  banned: null,
  banReason: null,
  banExpires: null,
  twoFactorEnabled: true,
  operationalAlerts: true,
};

type GrantRow = { id: string; userId: string; clientId: string; revokedAt: Date | null };

function buildPrisma({
  grant = { id: GRANT_ID, userId: SUB, clientId: CLIENT_ID, revokedAt: null } satisfies GrantRow,
  user = healthyUser,
}: {
  grant?: GrantRow | null;
  user?: McpSessionUser | null;
} = {}): McpAuthPrisma {
  return {
    mcpGrant: { findUnique: vi.fn(async () => grant) },
    user: { findUnique: vi.fn(async () => user) },
  } as unknown as McpAuthPrisma;
}

function buildTransport() {
  const transport: McpTransport & { calls: { authInfo?: AuthInfo }[] } = {
    calls: [],
    fetch: vi.fn(async (_request: Request, options?: { authInfo?: AuthInfo }) => {
      transport.calls.push({ authInfo: options?.authInfo });
      return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  };
  return transport;
}

function mcpRequest(headers: Record<string, string> = {}) {
  // Headers instance + set(): a plain init object would let undici's
  // forbidden-header handling drop `host`/`origin` spellings silently. The
  // direct Host header is always present on real wire requests; a
  // hand-constructed undici Request carries none, so set it explicitly
  // (tests override it with a hostile value where needed).
  const h = new Headers({ "content-type": "application/json" });
  for (const [key, value] of Object.entries(headers)) h.set(key, value);
  if (!h.has("host")) h.set("host", "proxy.example.com");
  return new Request(RESOURCE, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
  });
}

/** Mount the handler in a real Hono app so requestId threading is exercised. */
async function callHandler(
  handler: ReturnType<typeof createMcpRequestHandler>,
  request: Request,
): Promise<Response> {
  const app = new Hono<{ Variables: { requestId: string } }>();
  app.use("*", async (c, next) => {
    c.set("requestId", "req-test");
    // Stand in for the mounted chain's mcp:ip: limiter headers (F6): every
    // response from the handler — success OR failure — must keep them.
    c.header("X-RateLimit-Limit", "120");
    c.header("X-RateLimit-Remaining", "119");
    c.header("X-RateLimit-Reset", "1900000000");
    await next();
  });
  app.post("/mcp", handler);
  return app.request(request);
}

function buildHandler(overrides: Partial<Parameters<typeof createMcpRequestHandler>[0]> = {}) {
  const transport = buildTransport();
  const quota = vi.fn(async (): Promise<McpQuotaResult> => ({ ok: true }));
  const verified: McpVerifiedRequest[] = [];
  const handler = createMcpRequestHandler({
    authInstance: { options: {}, $context: Promise.resolve({}) } as never,
    transport,
    prisma: buildPrisma(),
    isForceTwoFactorRequired: async () => false,
    consumeIdentityQuota: quota,
    now: () => new Date("2026-06-01T00:00:00Z"),
    onVerified: (v) => verified.push(v),
    ...overrides,
  });
  return { handler, transport, quota, verified };
}

/** Valid verified claims for the happy path. */
function validClaims(): Record<string, unknown> {
  return {
    sub: SUB,
    client_id: CLIENT_ID,
    scope: "mcp:read offline_access",
    exp: 1_900_000_000,
    mcp_grant_id: GRANT_ID,
    iss: `${BASE}/api/auth`,
    aud: RESOURCE,
  };
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  upstreamState.claims = validClaims();
  upstreamState.capturedOpts = null;
  upstreamState.receivedRequest = null;
  upstreamState.failWrapper = null;
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  vi.clearAllMocks();
});

describe("createMcpRequestHandler — upstream wrapper wiring", () => {
  it("passes the canonical issuer, resource, read baseline, and write-satisfies-read matcher upstream", async () => {
    const { handler } = buildHandler();
    // The upstream wrapper is constructed per request (so the request ID
    // threads through); fire one request to capture its options.
    await callHandler(handler, mcpRequest({ authorization: `Bearer ${TOKEN}` }));
    expect(upstreamState.capturedOpts).toMatchObject({
      issuer: `${BASE}/api/auth`,
      resource: RESOURCE,
      requiredScopes: ["mcp:read"],
    });
  });

  it("scope predicate: mcp:write satisfies the read baseline; mcp:read alone never satisfies write", () => {
    const read = new Set(["mcp:read"]);
    const write = new Set(["mcp:write"]);
    const both = new Set(["mcp:read", "mcp:write"]);
    const neither = new Set(["offline_access"]);
    expect(mcpReadBaselineMatcher("mcp:read", read)).toBe(true);
    expect(mcpReadBaselineMatcher("mcp:read", write)).toBe(true);
    expect(mcpReadBaselineMatcher("mcp:read", both)).toBe(true);
    expect(mcpReadBaselineMatcher("mcp:read", neither)).toBe(false);
    expect(mcpReadBaselineMatcher("mcp:write", write)).toBe(true);
    expect(mcpReadBaselineMatcher("mcp:write", read)).toBe(false);
    expect(mcpReadBaselineMatcher("mcp:write", both)).toBe(true);
  });
});

describe("createMcpRequestHandler — admission decisions", () => {
  it("valid token + active grant + healthy user → transport reached with the pinned AuthInfo shape", async () => {
    const { handler, transport, quota, verified } = buildHandler();
    const res = await callHandler(handler, mcpRequest({ authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(200);
    expect(transport.calls).toHaveLength(1);
    expect(quota).toHaveBeenCalledWith(SUB, CLIENT_ID);

    const authInfo = transport.calls[0]?.authInfo;
    expect(authInfo).toBeDefined();
    expect(authInfo?.token).toBe(TOKEN);
    expect(authInfo?.clientId).toBe(CLIENT_ID);
    expect(authInfo?.scopes).toEqual(["mcp:read", "offline_access"]);
    expect(authInfo?.expiresAt).toBe(1_900_000_000);
    expect(authInfo?.resource).toEqual(new URL(RESOURCE));
    expect(authInfo?.extra).toMatchObject({ sub: SUB, mcp_grant_id: GRANT_ID });

    // The synthetic oRPC context: same user id, synthetic marker token —
    // NEVER the presented access token.
    expect(verified).toHaveLength(1);
    expect(verified[0]?.orpcContext.session.user.id).toBe(SUB);
    expect(verified[0]?.orpcContext.session.session.token).toBe(MCP_SYNTHETIC_SESSION_TOKEN);
    expect(JSON.stringify(verified[0]?.orpcContext)).not.toContain(TOKEN);
  });

  it("DPoP-presented credential is carried with the same AuthInfo shape", async () => {
    const { handler, transport } = buildHandler();
    const res = await callHandler(handler, mcpRequest({ authorization: `DPoP ${TOKEN}` }));
    expect(res.status).toBe(200);
    expect(transport.calls[0]?.authInfo?.token).toBe(TOKEN);
  });

  it("missing sub → 401 with an invalid_token challenge carrying resource_metadata", async () => {
    upstreamState.claims = { ...validClaims(), sub: undefined };
    const { handler, transport } = buildHandler();
    const res = await callHandler(handler, mcpRequest({ authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain(
      'resource_metadata="https://proxy.example.com/.well-known/oauth-protected-resource/mcp"',
    );
    expect(transport.calls).toHaveLength(0);
  });

  it.each([
    ["empty client_id", { client_id: "" }],
    ["non-string client_id", { client_id: 42 }],
  ])("%s → 401", async (_label, claimOverride) => {
    upstreamState.claims = { ...validClaims(), ...claimOverride };
    const { handler, transport } = buildHandler();
    const res = await callHandler(handler, mcpRequest({ authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(401);
    expect(transport.calls).toHaveLength(0);
  });

  it("missing mcp_grant_id claim → 401 (no grant binding)", async () => {
    upstreamState.claims = { ...validClaims(), mcp_grant_id: undefined };
    const { handler, transport } = buildHandler();
    const res = await callHandler(handler, mcpRequest({ authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(401);
    expect(transport.calls).toHaveLength(0);
  });

  it("missing presented credential (no Authorization header) → 401", async () => {
    const { handler, transport } = buildHandler();
    const res = await callHandler(handler, mcpRequest());
    expect(res.status).toBe(401);
    expect(transport.calls).toHaveLength(0);
  });

  it.each([
    ["grant row missing", () => buildPrisma({ grant: null })],
    [
      "grant belongs to a different user",
      () =>
        buildPrisma({
          grant: { id: GRANT_ID, userId: "other-user", clientId: CLIENT_ID, revokedAt: null },
        }),
    ],
    [
      "grant belongs to a different client",
      () =>
        buildPrisma({
          grant: { id: GRANT_ID, userId: SUB, clientId: "other-client", revokedAt: null },
        }),
    ],
    [
      "grant revoked (tombstoned)",
      () =>
        buildPrisma({
          grant: {
            id: GRANT_ID,
            userId: SUB,
            clientId: CLIENT_ID,
            revokedAt: new Date("2026-05-01T00:00:00Z"),
          },
        }),
    ],
  ])("%s → 403 with NO challenge and no transport call", async (_label, makePrisma) => {
    const prisma = makePrisma();
    const { handler, transport } = buildHandler({ prisma });
    const res = await callHandler(handler, mcpRequest({ authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(transport.calls).toHaveLength(0);
  });

  it("missing user → 401 invalid_token (stale subject)", async () => {
    const { handler, transport } = buildHandler({ prisma: buildPrisma({ user: null }) });
    const res = await callHandler(handler, mcpRequest({ authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(401);
    expect(transport.calls).toHaveLength(0);
  });

  it("actively banned user → 403; expired ban → admitted", async () => {
    const banned: McpSessionUser = { ...healthyUser, banned: true, banExpires: null };
    const tempBanned: McpSessionUser = {
      ...healthyUser,
      banned: true,
      banExpires: new Date("2026-06-02T00:00:00Z"),
    };
    const expiredBan: McpSessionUser = {
      ...healthyUser,
      banned: true,
      banExpires: new Date("2026-05-01T00:00:00Z"),
    };

    const denied = buildHandler({ prisma: buildPrisma({ user: banned }) });
    expect(
      (await callHandler(denied.handler, mcpRequest({ authorization: `Bearer ${TOKEN}` }))).status,
    ).toBe(403);
    expect(denied.transport.calls).toHaveLength(0);

    const tempDenied = buildHandler({ prisma: buildPrisma({ user: tempBanned }) });
    expect(
      (await callHandler(tempDenied.handler, mcpRequest({ authorization: `Bearer ${TOKEN}` })))
        .status,
    ).toBe(403);

    const admitted = buildHandler({ prisma: buildPrisma({ user: expiredBan }) });
    expect(
      (await callHandler(admitted.handler, mcpRequest({ authorization: `Bearer ${TOKEN}` })))
        .status,
    ).toBe(200);
  });

  it("force-2FA policy on + twoFactorEnabled falsy → 403; enabled or policy off → admitted", async () => {
    const noTwoFactor: McpSessionUser = { ...healthyUser, twoFactorEnabled: false };
    const enforced = buildHandler({
      prisma: buildPrisma({ user: noTwoFactor }),
      isForceTwoFactorRequired: async () => true,
    });
    expect(
      (await callHandler(enforced.handler, mcpRequest({ authorization: `Bearer ${TOKEN}` })))
        .status,
    ).toBe(403);
    expect(enforced.transport.calls).toHaveLength(0);

    const policyOff = buildHandler({
      prisma: buildPrisma({ user: noTwoFactor }),
      isForceTwoFactorRequired: async () => false,
    });
    expect(
      (await callHandler(policyOff.handler, mcpRequest({ authorization: `Bearer ${TOKEN}` })))
        .status,
    ).toBe(200);

    const enabled = buildHandler({
      prisma: buildPrisma({ user: healthyUser }),
      isForceTwoFactorRequired: async () => true,
    });
    expect(
      (await callHandler(enabled.handler, mcpRequest({ authorization: `Bearer ${TOKEN}` }))).status,
    ).toBe(200);
  });

  it("identity quota exhausted → 429 with Retry-After, transport NOT reached", async () => {
    const { handler, transport } = buildHandler({
      consumeIdentityQuota: async () => ({ ok: false, retryAfterSeconds: 42 }),
    });
    const res = await callHandler(handler, mcpRequest({ authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(transport.calls).toHaveLength(0);
  });

  it("identity quota is keyed by VERIFIED sub + client_id (pinned by the consume call)", async () => {
    const { handler, quota } = buildHandler();
    await callHandler(handler, mcpRequest({ authorization: `Bearer ${TOKEN}` }));
    expect(quota.mock.calls).toEqual([[SUB, CLIENT_ID]]);
  });

  it("unexpected Prisma failure → generic internal error with request ID; sanitized log only", async () => {
    const prisma = buildPrisma();
    (prisma.mcpGrant.findUnique as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Prisma SQL with secret 'hunter2' leaked"),
    );
    const { handler, transport } = buildHandler({ prisma });
    const res = await callHandler(handler, mcpRequest({ authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code?: number; data?: { requestId?: string } } };
    expect(body.error?.code).toBe(-32603);
    expect(body.error?.data?.requestId).toBe("req-test");
    expect(transport.calls).toHaveLength(0);
    for (const line of errorSpy.mock.calls.flat().map(String)) {
      expect(line).not.toContain("hunter2");
      expect(line).not.toContain("Prisma SQL");
    }
  });

  it("scope claim with duplicates/padding collapses to deduped literal scopes", async () => {
    upstreamState.claims = { ...validClaims(), scope: "mcp:read mcp:read offline_access" };
    const { handler, transport } = buildHandler();
    await callHandler(handler, mcpRequest({ authorization: `Bearer ${TOKEN}` }));
    expect(transport.calls[0]?.authInfo?.scopes).toEqual(["mcp:read", "offline_access"]);
  });
});

describe("createMcpRequestHandler — canonical-authority boundary (F1)", () => {
  it("hostile Host → static 400 BEFORE the upstream verifier; verifier never invoked", async () => {
    const { handler, transport } = buildHandler();
    const res = await callHandler(
      handler,
      mcpRequest({ authorization: `Bearer ${TOKEN}`, host: "evil.example.com" }),
    );
    expect(res.status).toBe(400);
    expect(upstreamState.receivedRequest).toBeNull();
    expect(transport.calls).toHaveLength(0);
  });

  it("hostile Origin → static 400 BEFORE the upstream verifier", async () => {
    const { handler, transport } = buildHandler();
    const res = await callHandler(
      handler,
      mcpRequest({ authorization: `Bearer ${TOKEN}`, origin: "https://evil.example" }),
    );
    expect(res.status).toBe(400);
    expect(upstreamState.receivedRequest).toBeNull();
    expect(transport.calls).toHaveLength(0);
  });

  it("ambiguous authority (absolute-form URL host conflicts with Host) → 400", async () => {
    const { handler } = buildHandler();
    const conflicting = new Request("https://other.example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", host: "proxy.example.com" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    const res = await callHandler(handler, conflicting);
    expect(res.status).toBe(400);
    expect(upstreamState.receivedRequest).toBeNull();
  });

  it("spoofed x-forwarded-host on the canonical direct Host is IGNORED (canonical host branch)", async () => {
    const { handler } = buildHandler();
    const res = await callHandler(
      handler,
      mcpRequest({
        authorization: `Bearer ${TOKEN}`,
        "x-forwarded-host": "evil.example.com",
      }),
    );
    expect(res.status).toBe(200);
  });

  it("HTTP-ingress request with the canonical Host is verified against the CONFIGURED https origin (DPoP htu fix)", async () => {
    // TLS termination at a proxy: the socket here is plain HTTP, the direct
    // Host is the canonical public host. The boundary must hand the
    // verifier a canonical clone on the CONFIGURED https origin — DPoP
    // `htu` is then derived from configuration, never the socket scheme.
    const { handler } = buildHandler();
    const httpIngress = new Request("http://proxy.example.com/mcp", {
      method: "POST",
      headers: new Headers({
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
        host: "proxy.example.com",
      }),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    const res = await callHandler(handler, httpIngress);
    expect(res.status).toBe(200);
    expect(upstreamState.receivedRequest?.url).toBe(RESOURCE);
    expect(upstreamState.receivedRequest?.url.startsWith("https://")).toBe(true);
  });

  it("absent Origin passes the boundary (native clients send no Origin)", async () => {
    const { handler } = buildHandler();
    const res = await callHandler(handler, mcpRequest({ authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(200);
  });

  it.each(["https://proxy.example.com", "https://app.example.com"] as const)(
    "allowed Origin %s passes the boundary (web origin + server origin)",
    async (origin) => {
      const { handler } = buildHandler();
      const res = await callHandler(
        handler,
        mcpRequest({ authorization: `Bearer ${TOKEN}`, origin }),
      );
      expect(res.status).toBe(200);
      expect(upstreamState.receivedRequest).not.toBeNull();
    },
  );

  it("canonical clone preserves method, path, query, body, and the presented credential", async () => {
    const { handler, transport } = buildHandler();
    const res = await callHandler(handler, mcpRequest({ authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(200);
    const received = upstreamState.receivedRequest;
    expect(received?.method).toBe("POST");
    expect(received?.url).toBe(RESOURCE);
    expect(received?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(transport.calls).toHaveLength(1);
  });
});

describe("createMcpRequestHandler — failure responses keep the limiter headers (F6)", () => {
  it("unexpected verifier rejection → generic 500 with request ID AND preserved X-RateLimit headers; quota consumed", async () => {
    const { handler, transport } = buildHandler();
    upstreamState.failWrapper = new Error("verifier exploded with secret 'hunter2'");
    const res = await callHandler(handler, mcpRequest({ authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(500);
    expect(res.headers.get("x-ratelimit-limit")).toBe("120");
    expect(res.headers.get("x-ratelimit-remaining")).toBe("119");
    const body = (await res.json()) as { error?: { code?: number; data?: { requestId?: string } } };
    expect(body.error?.code).toBe(-32603);
    expect(body.error?.data?.requestId).toBe("req-test");
    expect(transport.calls).toHaveLength(0);
    // The wrapper-level failure precedes admission, so quota is NOT yet
    // consumed on this path (the transport-rejection test covers the
    // consumed-quota variant after full admission).
    for (const line of errorSpy.mock.calls.flat().map(String)) {
      expect(line).not.toContain("hunter2");
    }
  });

  it("rejected transport (fetch throws after full admission) → generic 500 with preserved X-RateLimit headers", async () => {
    const transport: McpTransport = {
      fetch: vi.fn(async () => {
        throw new Error("transport broke, secret 'opensesame' inside");
      }),
    };
    const { handler, quota } = buildHandler({ transport });
    const res = await callHandler(handler, mcpRequest({ authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(500);
    expect(res.headers.get("x-ratelimit-limit")).toBe("120");
    expect(res.headers.get("x-ratelimit-remaining")).toBe("119");
    expect(quota).toHaveBeenCalledWith(SUB, CLIENT_ID);
    const body = (await res.json()) as { error?: { code?: number; data?: { requestId?: string } } };
    expect(body.error?.code).toBe(-32603);
    expect(body.error?.data?.requestId).toBe("req-test");
    for (const line of errorSpy.mock.calls.flat().map(String)) {
      expect(line).not.toContain("opensesame");
    }
  });

  it("rejected auth context (upstream 401 Response) still carries the limiter headers", async () => {
    const { handler } = buildHandler();
    const res = await callHandler(handler, mcpRequest());
    expect(res.status).toBe(401);
    expect(res.headers.get("x-ratelimit-limit")).toBe("120");
  });
});

describe("createMcpRequestHandler — ban-boundary parity (F5)", () => {
  const NOW = new Date("2026-06-01T00:00:00Z");

  it("banExpires exactly at now → STILL BANNED (403); now-1ms → admitted", async () => {
    const equalBanned: McpSessionUser = { ...healthyUser, banned: true, banExpires: NOW };
    const denied = buildHandler({ prisma: buildPrisma({ user: equalBanned }) });
    expect(
      (await callHandler(denied.handler, mcpRequest({ authorization: `Bearer ${TOKEN}` }))).status,
    ).toBe(403);
    expect(denied.transport.calls).toHaveLength(0);

    const justExpired: McpSessionUser = {
      ...healthyUser,
      banned: true,
      banExpires: new Date(NOW.getTime() - 1),
    };
    const admitted = buildHandler({ prisma: buildPrisma({ user: justExpired }) });
    expect(
      (await callHandler(admitted.handler, mcpRequest({ authorization: `Bearer ${TOKEN}` })))
        .status,
    ).toBe(200);
  });
});

describe("createMcpRequestHandler — dynamic log-field protection (F7)", () => {
  it("CIMD query-bearing client_id is redacted whole from every sanitized log line (admission-denial path)", async () => {
    const evilClientId = "https://client.example.com/client.json?access_token=CIMD_SECRET_TOKEN";
    upstreamState.claims = { ...validClaims(), client_id: evilClientId };
    // Grant belongs to a different client → denial path logs client=<id>.
    const prisma = buildPrisma({
      grant: { id: GRANT_ID, userId: SUB, clientId: "other-client", revokedAt: null },
    });
    const { handler, transport } = buildHandler({ prisma });
    const res = await callHandler(handler, mcpRequest({ authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(403);
    expect(transport.calls).toHaveLength(0);
    const lines = errorSpy.mock.calls.flat().map(String);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain("CIMD_SECRET_TOKEN");
      expect(line).not.toContain("access_token");
      expect(line).not.toContain("client.example.com/client.json");
    }
    // The redaction is visible (whole-field), not silent truncation.
    expect(lines.some((l: string) => l.includes("client=[redacted]"))).toBe(true);
  });
});

describe("createMcpRequestHandler — synthetic context contract (F4)", () => {
  it("verified context satisfies the production shape: full user row + session audit timestamps, token still excluded", async () => {
    const { handler, verified } = buildHandler();
    await callHandler(handler, mcpRequest({ authorization: `Bearer ${TOKEN}` }));
    expect(verified).toHaveLength(1);
    const ctx = verified[0]?.orpcContext;
    expect(ctx?.session.user).toEqual(healthyUser);
    expect(ctx?.session.user.createdAt).toEqual(healthyUser.createdAt);
    expect(ctx?.session.user.operationalAlerts).toBe(true);
    expect(ctx?.session.session.createdAt).toBeInstanceOf(Date);
    expect(ctx?.session.session.updatedAt).toBeInstanceOf(Date);
    expect(ctx?.session.session.token).toBe(MCP_SYNTHETIC_SESSION_TOKEN);
    expect(JSON.stringify(ctx)).not.toContain(TOKEN);
  });
});

describe("extractPresentedCredential", () => {
  it("parses Bearer and DPoP (case-insensitive scheme), rejects everything else", () => {
    expect(extractPresentedCredential(`Bearer ${TOKEN}`)).toEqual({
      scheme: "Bearer",
      token: TOKEN,
    });
    expect(extractPresentedCredential(`bearer ${TOKEN}`)).toEqual({
      scheme: "Bearer",
      token: TOKEN,
    });
    expect(extractPresentedCredential(`DPoP ${TOKEN}`)).toEqual({ scheme: "DPoP", token: TOKEN });
    expect(extractPresentedCredential(`dpop ${TOKEN}`)).toEqual({ scheme: "DPoP", token: TOKEN });
    expect(extractPresentedCredential("Basic abc")).toBeNull();
    expect(extractPresentedCredential("Bearer")).toBeNull();
    expect(extractPresentedCredential("Bearer ")).toBeNull();
    expect(extractPresentedCredential(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Part F pass 3 — F8 (shutdown admission barrier) + F9 (SDK internal-error
// request-ID correlation). The upstream verifier stays mocked (fabricated
// VERIFIED claims — the established seam in this suite); the MCP transport
// is the REAL installed handler wherever the finding probes demanded it.
// ---------------------------------------------------------------------------

const MODERN_ENVELOPE = {
  [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
  [CLIENT_INFO_META_KEY]: { name: "probe-client", version: "0.0.0" },
  [CLIENT_CAPABILITIES_META_KEY]: {},
} as const;

/** A modern (2026-07-28 envelope) request through the route handler. */
function modernMcpRequest(method = "tools/list") {
  const h = new Headers({
    "content-type": "application/json",
    host: "proxy.example.com",
    "mcp-method": method,
  });
  h.set("authorization", `Bearer ${TOKEN}`);
  return new Request(RESOURCE, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method,
      params: { _meta: MODERN_ENVELOPE },
    }),
  });
}

describe("createMcpRequestHandler — shutdown admission barrier (F8)", () => {
  it("post-close admission → 503 JSON-RPC error; verifier + transport never run; chain headers preserved", async () => {
    const gate = createMcpAdmissionGate();
    await gate.close();
    const { handler, transport } = buildHandler({ admissionGate: gate });
    const res = await callHandler(handler, mcpRequest({ authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(503);
    expect(res.headers.get("x-ratelimit-limit")).toBe("120");
    const body = (await res.json()) as {
      jsonrpc?: string;
      error?: { code?: number; message?: string };
      id?: unknown;
    };
    expect(body).toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Server is shutting down" },
      id: null,
    });
    expect(transport.calls).toHaveLength(0);
  });

  it("NORMAL DRAIN (F8 pass 4): an admitted in-flight request COMPLETES while the gate is open — no spurious abort", async () => {
    const gate = createMcpAdmissionGate();
    let resolveTransport!: (response: Response) => void;
    const transport: McpTransport = {
      fetch: vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveTransport = resolve;
          }),
      ),
    };
    const { handler } = buildHandler({ admissionGate: gate, transport });
    const pending = callHandler(handler, mcpRequest({ authorization: `Bearer ${TOKEN}` }));
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalled());
    // The exchange completes normally: resolving the transport finishes it
    // with 200 while the gate is still OPEN (the graceful-shutdown sequence
    // drains HTTP before gate.close(), so live exchanges are never aborted).
    resolveTransport(
      new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await pending;
    expect(res.status).toBe(200);
    expect(gate.outstanding).toBe(0);
    // And a later close resolves instantly — nothing was leaked.
    await expect(gate.close()).resolves.toBeUndefined();
  });

  it("BOUNDED CLOSE (F8 pass 4/5): close() ABORTS outstanding work — a never-settling transport cannot hang the gate (permit releases at the shadow-await cap)", async () => {
    const gate = createMcpAdmissionGate();
    const transport: McpTransport = {
      fetch: vi.fn(() => new Promise<Response>(() => {})),
    };
    // Small shadow-await budget (F8 pass 5): the admitted promise is stuck
    // on the never-settling transport fetch forever, so the abort-path
    // permit release settles at the cap (the default budget is 10s — too
    // slow for a unit test; the production rationale lives in auth.ts).
    const { handler } = buildHandler({
      admissionGate: gate,
      transport,
      abortShadowAwaitMs: 25,
    });
    const controller = new AbortController();
    const h = new Headers({ "content-type": "application/json", host: "proxy.example.com" });
    h.set("authorization", `Bearer ${TOKEN}`);
    const request = new Request(RESOURCE, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
      signal: controller.signal,
    });
    const pending = callHandler(handler, request);
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalled());
    // NO client abort here: close() itself must cancel the exchange (abort
    // the owned controller) so the handler settles through its race and
    // answers 499 promptly; the permit then releases at the shadow-await
    // cap (the admitted promise never settles) — close() is bounded either
    // way. The sanitized cap log line fires (errorSpy captures it).
    await expect(gate.close()).resolves.toBeUndefined();
    expect(gate.outstanding).toBe(0);
    const res = await pending;
    expect(res.status).toBe(499);
    expect(
      errorSpy.mock.calls
        .flat()
        .some((l: string) => String(l).includes("shadow-await budget reached")),
    ).toBe(true);
  });

  it("ABORT DURING PENDING GRANT LOOKUP (F8 pass 4/5): the user lookup NEVER starts and the permit releases at the cap while the grant query hangs", async () => {
    const gate = createMcpAdmissionGate();
    const events: string[] = [];
    let finishGrant!: (grant: GrantRow) => void;
    const prisma = {
      mcpGrant: {
        findUnique: vi.fn(
          () =>
            new Promise((resolve) => {
              events.push("grant:start");
              finishGrant = resolve;
            }),
        ),
      },
      user: {
        findUnique: vi.fn(async () => {
          events.push("user:start");
          return healthyUser;
        }),
      },
    } as unknown as McpAuthPrisma;
    const transport: McpTransport = { fetch: vi.fn() };
    const { handler } = buildHandler({
      admissionGate: gate,
      prisma,
      transport,
      abortShadowAwaitMs: 25,
    });
    const controller = new AbortController();
    const h = new Headers({ "content-type": "application/json", host: "proxy.example.com" });
    h.set("authorization", `Bearer ${TOKEN}`);
    const request = new Request(RESOURCE, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
      signal: controller.signal,
    });
    const pending = callHandler(handler, request);
    await vi.waitFor(() => expect(events).toContain("grant:start"));
    // Peer disconnect while the grant query is in flight.
    controller.abort();
    // close() must settle WITHOUT the grant promise resolving: the abort
    // race settles the handler, the stage fences stop the abandoned
    // continuation at the grant await, and the permit releases at the
    // shadow-await cap (the grant promise is still pending forever).
    await gate.close();
    events.push("prisma:disconnect");
    finishGrant({ id: GRANT_ID, userId: SUB, clientId: CLIENT_ID, revokedAt: null });
    const res = await pending;
    expect(res.status).toBe(499);
    // The user lookup NEVER started — not before the disconnect, not after.
    expect(events).not.toContain("user:start");
    expect(events.indexOf("prisma:disconnect")).toBeGreaterThan(events.indexOf("grant:start"));
    expect(transport.fetch).not.toHaveBeenCalled();
  });

  it("ALREADY-ABORTED ENTRY (F8 pass 4): immediate safe response, NOTHING admitted, close() instant", async () => {
    const gate = createMcpAdmissionGate();
    const prisma = buildPrisma();
    const transport: McpTransport = { fetch: vi.fn() };
    const { handler } = buildHandler({ admissionGate: gate, prisma, transport });
    const controller = new AbortController();
    controller.abort();
    const h = new Headers({ "content-type": "application/json", host: "proxy.example.com" });
    h.set("authorization", `Bearer ${TOKEN}`);
    const abortedRequest = new Request(RESOURCE, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
      signal: controller.signal,
    });
    const response = await callHandler(handler, abortedRequest);
    expect(response.status).toBe(499);
    const body = (await response.json()) as { error?: { code?: number } };
    expect(body.error?.code).toBe(-32000);
    // Synchronous entry fence: no permit, no listener — the gate never
    // moved off 0 and close() is instant.
    expect(gate.outstanding).toBe(0);
    await expect(gate.close()).resolves.toBeUndefined();
    expect(prisma.mcpGrant.findUnique).not.toHaveBeenCalled();
    expect(transport.fetch).not.toHaveBeenCalled();
  });

  it("NO LISTENER LEAK: the client-signal abort listener is removed when every request settles", async () => {
    const gate = createMcpAdmissionGate();
    const { handler } = buildHandler({ admissionGate: gate });
    const REQUESTS = 5;
    const tallies: { added: number; removed: number }[] = [];
    const pendings: Promise<{ added: number; removed: number }>[] = [];
    for (let i = 0; i < REQUESTS; i += 1) {
      const controller = new AbortController();
      const h = new Headers({ "content-type": "application/json", host: "proxy.example.com" });
      h.set("authorization", `Bearer ${TOKEN}`);
      // Instrument AFTER Request construction so undici's own internal
      // signal bookkeeping (if any) is not counted — only the handler's
      // add/remove pair for "abort" is.
      const request = new Request(RESOURCE, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ jsonrpc: "2.0", id: i, method: "ping", params: {} }),
        signal: controller.signal,
      });
      // `new Request(..., { signal })` composes a NEW signal object that
      // follows the controller's — and Hono hands that composed object to
      // the handler as c.req.raw.signal. Instrument IT (after construction,
      // so undici's own composition bookkeeping is not counted).
      const signal = request.signal;
      let added = 0;
      let removed = 0;
      const origAdd = signal.addEventListener.bind(signal);
      const origRemove = signal.removeEventListener.bind(signal);
      Object.defineProperty(signal, "addEventListener", {
        value: (...args: Parameters<typeof origAdd>) => {
          if (args[0] === "abort") added += 1;
          return origAdd(...args);
        },
      });
      Object.defineProperty(signal, "removeEventListener", {
        value: (...args: Parameters<typeof origRemove>) => {
          if (args[0] === "abort") removed += 1;
          return origRemove(...args);
        },
      });
      pendings.push(
        callHandler(handler, request).then((response) => {
          void response;
          return { added, removed };
        }),
      );
    }
    const settled = await Promise.all(pendings);
    tallies.push(...settled);
    for (const tally of tallies) {
      expect(tally.added).toBe(1);
      expect(tally.removed).toBe(1);
    }
    expect(gate.outstanding).toBe(0);
  });

  it("REAL transport: a request still reading its body NEVER reaches the factory after close (drain-timeout connection termination)", async () => {
    const events: string[] = [];
    const transport = createMcpTransport({
      registerTools: (server: McpServer) => {
        events.push("factory");
        server.registerTool("probe", {}, async () => ({
          content: [{ type: "text" as const, text: "ok" }],
        }));
      },
    });
    const gate = createMcpAdmissionGate();
    const { handler } = buildHandler({ admissionGate: gate, transport });

    // Modern request whose body trickles in slowly: the route admits it at
    // ENTRY (before any body handling) while the SDK parks reading the
    // stream — exactly the pre-factory window the SDK's close() cannot see.
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/list",
      params: { _meta: MODERN_ENVELOPE },
    });
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const slowBody = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
    });
    const h = new Headers({
      "content-type": "application/json",
      host: "proxy.example.com",
      "mcp-method": "tools/list",
    });
    h.set("authorization", `Bearer ${TOKEN}`);
    const request = new Request(RESOURCE, {
      method: "POST",
      headers: h,
      body: slowBody,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const pending = callHandler(handler, request);
    await new Promise((resolve) => setTimeout(resolve, 30)); // SDK now parked reading the body

    // The index.ts shutdown sequence: close the gate (flips the gate
    // closed — arming the auth DB-seam fence — and aborts the OWNED
    // controller the canonical clone carries) + the SDK handler (which has
    // NOTHING tracked — no server exists yet), then the HTTP layer
    // terminates the connection. NOTE (F8 pass 5): aborting the owned
    // signal does NOT cancel the SDK's body read of the clone — the body
    // stream is errored below by the connection-termination simulation,
    // and the FACTORY FENCE is the enforcement that no server is created.
    const gateClosed = gate.close();
    const transportClosed = transport.close();
    bodyController.error(new Error("socket destroyed"));

    const res = await pending;
    await Promise.all([gateClosed, transportClosed]);
    void payload;

    // The factory NEVER ran post-close (mutation-sensitive: without the
    // barrier the reviewers' probe recorded factory → tool → server-close
    // DURING the Prisma disconnect), and the exchange SETTLED with the
    // safe JSON-RPC 499 (the route abort race owns the response; the SDK's
    // own unreadable-body 400 loses the race to the already-aborted signal).
    expect(events).not.toContain("factory");
    expect(res.status).toBe(499);
    const body = (await res.json()) as {
      error?: { code?: number; message?: string };
    };
    expect(body.error?.code).toBe(-32000);
  });

  it("BUFFERED FINAL BODY + ABORT (F8 pass 4): the FACTORY FENCE blocks server creation post-abort (real SDK)", async () => {
    const events: string[] = [];
    const transport = createMcpTransport({
      registerTools: () => {
        events.push("factory");
      },
    });
    const gate = createMcpAdmissionGate();
    const { handler } = buildHandler({ admissionGate: gate, transport });
    const signalController = new AbortController();
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
    });
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/list",
      params: { _meta: MODERN_ENVELOPE },
    });
    const h = new Headers({
      "content-type": "application/json",
      host: "proxy.example.com",
      "mcp-method": "tools/list",
    });
    h.set("authorization", `Bearer ${TOKEN}`);
    const request = new Request(RESOURCE, {
      method: "POST",
      headers: h,
      body,
      duplex: "half",
      signal: signalController.signal,
    } as RequestInit & { duplex: "half" });
    const pending = callHandler(handler, request);
    await new Promise((resolve) => setTimeout(resolve, 30));
    // All request bytes are already buffered by the time the peer
    // disconnects: the SDK is past the body read and about to invoke the
    // factory — only the FACTORY FENCE (owned signal) stops it.
    bodyController.enqueue(new TextEncoder().encode(payload));
    bodyController.close();
    signalController.abort();
    await Promise.all([gate.close(), transport.close()]);
    const res = await pending;
    expect(events).not.toContain("factory");
    expect(res.status).toBe(499);
    await transport.close();
  });
});

describe("createMcpRequestHandler — SDK internal-error request-ID correlation (F9)", () => {
  it("REAL transport factory failure → SDK 500 -32603 WITH error.data.requestId AND preserved X-RateLimit headers; no sentinel anywhere", async () => {
    const transport = createMcpTransport({
      registerTools: () => {
        throw new Error("F9-sentinel-secret");
      },
    });
    const { handler, quota } = buildHandler({ transport });
    const res = await callHandler(handler, modernMcpRequest());
    expect(res.status).toBe(500);
    expect(res.headers.get("x-ratelimit-limit")).toBe("120");
    expect(res.headers.get("x-ratelimit-remaining")).toBe("119");
    const body = (await res.json()) as {
      jsonrpc?: string;
      error?: { code?: number; message?: string; data?: { requestId?: string } };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error?.code).toBe(-32603);
    expect(body.error?.data?.requestId).toBe("req-test");
    // Full admission happened before the factory threw → quota consumed.
    expect(quota).toHaveBeenCalledWith(SUB, CLIENT_ID);
    // No sentinel in the body or ANY captured log line.
    expect(JSON.stringify(body)).not.toContain("F9-sentinel-secret");
    const lines = errorSpy.mock.calls.flat().map(String);
    expect(lines.some((l: string) => l.includes("sdk internal error response"))).toBe(true);
    expect(lines.some((l: string) => l.includes("request=req-test"))).toBe(true);
    for (const line of lines) {
      expect(line).not.toContain("F9-sentinel-secret");
    }
    await transport.close();
  });

  it("a non-JSON 5xx body passes through UNCHANGED (no augmentation, no throw)", async () => {
    const transport: McpTransport = {
      fetch: vi.fn(
        async () =>
          new Response("upstream exploded <html>", {
            status: 502,
            headers: { "content-type": "text/html" },
          }),
      ),
    };
    const { handler } = buildHandler({ transport });
    const res = await callHandler(handler, mcpRequest({ authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("upstream exploded <html>");
  });

  it("a JSON 5xx body that is NOT a JSON-RPC error passes through UNCHANGED", async () => {
    const transport: McpTransport = {
      fetch: vi.fn(
        async () =>
          new Response('{"oops":true}', {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
      ),
    };
    const { handler } = buildHandler({ transport });
    const res = await callHandler(handler, mcpRequest({ authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"oops":true}');
  });

  it("a successful response is never touched by the augmentation", async () => {
    const { handler } = buildHandler();
    const res = await callHandler(handler, mcpRequest({ authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  // -------------------------------------------------------------------------
  // F10 (pass 4): byte and framing preservation on the augmentation path.
  // -------------------------------------------------------------------------

  it("F10: augmentation RECOMPUTES Content-Length for the new representation (no stale length)", async () => {
    const oldBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32603, message: "Internal server error", data: { existing: true } },
    });
    const transport: McpTransport = {
      fetch: vi.fn(
        async () =>
          new Response(oldBody, {
            status: 500,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "content-length": String(Buffer.byteLength(oldBody)),
            },
          }),
      ),
    };
    const { handler } = buildHandler({ transport });
    const res = await callHandler(handler, mcpRequest({ authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(500);
    const text = await res.text();
    const body = JSON.parse(text) as { error?: { data?: Record<string, unknown> } };
    expect(body.error?.data).toEqual({ existing: true, requestId: "req-test" });
    // The header must agree with the AUGMENTED body's byte length — the
    // stale original length would truncate the client's read downstream.
    expect(res.headers.get("content-length")).toBe(String(Buffer.byteLength(text)));
    expect(res.headers.get("content-length")).not.toBe(String(Buffer.byteLength(oldBody)));
  });

  it("F10: malformed-UTF-8 5xx JSON body passes through BYTE-IDENTICAL (no replacement-character laundering)", async () => {
    const bytes = new Uint8Array([0x7b, 0xff, 0x7d]); // { <invalid> }
    const transport: McpTransport = {
      fetch: vi.fn(
        async () =>
          new Response(bytes, { status: 500, headers: { "content-type": "application/json" } }),
      ),
    };
    const { handler } = buildHandler({ transport });
    const res = await callHandler(handler, mcpRequest({ authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(500);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it("F10: a UTF-8 BOM 5xx JSON body passes through UNTOUCHED (BOM preserved, headers intact)", async () => {
    const inner = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32603, message: "Internal server error" },
    });
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(inner)]);
    const transport: McpTransport = {
      fetch: vi.fn(
        async () =>
          new Response(bytes, {
            status: 500,
            headers: {
              "content-type": "application/json",
              "content-length": String(bytes.byteLength),
            },
          }),
      ),
    };
    const { handler } = buildHandler({ transport });
    const res = await callHandler(handler, mcpRequest({ authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(500);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    // Framing untouched too: the original Content-Length survives verbatim
    // and no requestId was injected (JSON.parse rejects the BOM).
    expect(res.headers.get("content-length")).toBe(String(bytes.byteLength));
    const decoded = new TextDecoder().decode(bytes);
    expect(decoded).not.toContain("req-test");
  });
});

// ---------------------------------------------------------------------------
// Part F pass 5 — F8 reopen (DB-capable stray continuations: shadow-awaited
// release) + F10 reopen (losing-augmentation framing contamination).
// ---------------------------------------------------------------------------

describe("createMcpRequestHandler — shadow-awaited abort release (F8 pass 5)", () => {
  it("NORMAL PATH (no leak): a completed exchange releases its permit immediately — outstanding back to 0 and close() instant", async () => {
    const gate = createMcpAdmissionGate();
    const { handler } = buildHandler({ admissionGate: gate });
    const res = await callHandler(handler, mcpRequest({ authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(200);
    expect(gate.outstanding).toBe(0);
    await expect(gate.close()).resolves.toBeUndefined();
    // No shadow-await line on the normal path (release happens in the
    // finally, after the admitted promise already settled).
    expect(errorSpy.mock.calls.flat().some((l: string) => String(l).includes("shadow-await"))).toBe(
      false,
    );
  });

  it("ABORT PATH: the permit is HELD after the 499 until the admitted promise settles (shadow-await), then releases with NO cap line", async () => {
    const gate = createMcpAdmissionGate();
    let finishGrant!: (grant: GrantRow) => void;
    const prisma = {
      mcpGrant: {
        findUnique: vi.fn(
          () =>
            new Promise<GrantRow>((resolve) => {
              finishGrant = resolve;
            }),
        ),
      },
      user: { findUnique: vi.fn(async () => healthyUser) },
    } as unknown as McpAuthPrisma;
    const transport: McpTransport = { fetch: vi.fn() };
    // A LARGE shadow budget: this test pins the RELEASE-ON-SETTLEMENT half
    // (the cap half is pinned by the BOUNDED CLOSE test above).
    const { handler } = buildHandler({
      admissionGate: gate,
      prisma,
      transport,
      abortShadowAwaitMs: 60_000,
    });
    const controller = new AbortController();
    const h = new Headers({ "content-type": "application/json", host: "proxy.example.com" });
    h.set("authorization", `Bearer ${TOKEN}`);
    const request = new Request(RESOURCE, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
      signal: controller.signal,
    });
    const pending = callHandler(handler, request);
    await vi.waitFor(() => expect(prisma.mcpGrant.findUnique).toHaveBeenCalled());
    controller.abort();
    // The client gets its 499 promptly, but the permit is STILL HELD — the
    // admitted continuation (DB-capable: mid grant lookup) has not settled.
    const res = await pending;
    expect(res.status).toBe(499);
    expect(gate.outstanding).toBe(1);
    // The grant settles → the stage fence stops the continuation → the
    // admitted promise settles → the shadow-await releases (well inside
    // the 60s budget) → close() resolves with NO cap log line.
    const closing = gate.close();
    finishGrant({ id: GRANT_ID, userId: SUB, clientId: CLIENT_ID, revokedAt: null });
    await closing;
    expect(gate.outstanding).toBe(0);
    expect(transport.fetch).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().some((l: string) => String(l).includes("shadow-await"))).toBe(
      false,
    );
  });
});

describe("createMcpRequestHandler — F10 pass 5: losing continuation cannot mis-frame the winning response", () => {
  it("abort DURING the augmentation body-read → 499 with framing that matches ITS OWN body (no 500 leakage)", async () => {
    const gate = createMcpAdmissionGate();
    let releaseBody!: () => void;
    // An SDK-shaped 500 whose body only becomes readable AFTER the gate
    // closes: the augmentation awaits the clone's arrayBuffer() while the
    // abort wins the outer race.
    const bodyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        releaseBody = () => {
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({
                jsonrpc: "2.0",
                error: { code: -32603, message: "Internal server error" },
                id: 1,
              }),
            ),
          );
          controller.close();
        };
      },
    });
    const transport: McpTransport = {
      fetch: vi.fn(
        async () =>
          new Response(bodyStream, {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
      ),
    };
    const { handler } = buildHandler({ admissionGate: gate, transport });
    const pending = callHandler(handler, mcpRequest({ authorization: `Bearer ${TOKEN}` }));
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalled());
    // The augmentation is now parked on the body read; close wins the race.
    // The body is released BEFORE awaiting close() so the losing
    // continuation settles deterministically (the shadow-await would
    // otherwise wait for it — bounded by the default budget, too slow here).
    const closing = gate.close();
    releaseBody();
    await closing;
    const res = await pending;
    expect(res.status).toBe(499);
    const text = await res.text();
    // The winning 499's framing matches its OWN body — never the losing
    // 500's augmented length (the R60 probe recorded 499 with
    // Content-Length 114 framing an 85-byte body).
    const length = res.headers.get("content-length");
    expect(length === null || Number(length) === Buffer.byteLength(text)).toBe(true);
    expect(Number(res.headers.get("content-length"))).toBe(Buffer.byteLength(text));
    expect(JSON.parse(text)).toMatchObject({
      error: { code: -32000, message: "Client closed request" },
    });
    expect(text).not.toContain("-32603");
  });

  it("scheduling sweep (R60 reproducer, fake transport): no depth lets a losing 500 mis-frame the winning 499", async () => {
    const failures: object[] = [];
    for (let depth = 0; depth < 150; depth += 1) {
      const gate = createMcpAdmissionGate();
      const transport: McpTransport = {
        fetch: vi.fn(async () => {
          let remaining = depth;
          const tick = () => {
            if (remaining-- > 0) queueMicrotask(tick);
            else void gate.close();
          };
          queueMicrotask(tick);
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              error: { code: -32603, message: "Internal server error" },
            }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
        }),
      };
      const { handler } = buildHandler({ admissionGate: gate, transport });
      const response = await callHandler(handler, mcpRequest({ authorization: `Bearer ${TOKEN}` }));
      const body = await response.text();
      const length = response.headers.get("content-length");
      if (length !== null && Number(length) !== Buffer.byteLength(body)) {
        failures.push({ depth, status: response.status, length, actual: Buffer.byteLength(body) });
      }
      await gate.close();
    }
    expect(failures).toEqual([]);
  });

  it("scheduling sweep (R60 reproducer, REAL SDK transport): no depth mis-frames the final response", async () => {
    const failures: object[] = [];
    for (let depth = 0; depth < 150; depth += 1) {
      const gate = createMcpAdmissionGate();
      const transport = createMcpTransport({
        isShuttingDown: () => gate.closed,
        registerTools: () => {
          let remaining = depth;
          const tick = () => {
            if (remaining-- > 0) queueMicrotask(tick);
            else void gate.close();
          };
          queueMicrotask(tick);
          throw new Error("f10-synthetic-factory-failure");
        },
      });
      const { handler } = buildHandler({ admissionGate: gate, transport });
      const response = await callHandler(handler, modernMcpRequest());
      const body = await response.text();
      const length = response.headers.get("content-length");
      if (length !== null && Number(length) !== Buffer.byteLength(body)) {
        failures.push({ depth, status: response.status, length, actual: Buffer.byteLength(body) });
      }
      await Promise.all([gate.close(), transport.close()]);
    }
    expect(failures).toEqual([]);
    expect(
      errorSpy.mock.calls
        .flat()
        .some((l: string) => String(l).includes("f10-synthetic-factory-failure")),
    ).toBe(false);
  });

  it("a prior Content-Length set on the context can NEVER mis-frame a later early-exit response (all exits)", async () => {
    // Middleware on the chain sets a bogus length BEFORE the handler runs —
    // the same prepared-headers contamination a losing continuation's merge
    // produces (Hono merges response headers into the context's shared
    // prepared headers by reference). Every early exit must overwrite it
    // with its own byte-exact length.
    const bogus = "999";
    const plantedApp = (
      handler: ReturnType<typeof createMcpRequestHandler>,
      request: Request,
    ): Promise<Response> => {
      const app = new Hono<{ Variables: { requestId: string } }>();
      app.use("*", async (c, next) => {
        c.set("requestId", "req-test");
        c.header("X-RateLimit-Limit", "120");
        c.header("Content-Length", bogus);
        await next();
      });
      app.post("/mcp", handler);
      return Promise.resolve(app.request(request));
    };
    const transport500: McpTransport = {
      fetch: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    // A gate that closes as soon as the verifier continuation starts → the
    // abort race owns the response (499 path).
    const abortingGate = createMcpAdmissionGate();
    let closeAbortGate = () => {};
    const abortingTransport: McpTransport = {
      fetch: vi.fn(async () => {
        closeAbortGate();
        return new Response(null);
      }),
    };
    const abortingHandler = buildHandler({
      admissionGate: abortingGate,
      transport: abortingTransport,
    }).handler;
    closeAbortGate = () => void abortingGate.close();
    const gateClosed = createMcpAdmissionGate();
    await gateClosed.close();
    const cases: Array<[string, Promise<Response>]> = [
      [
        "499 abort-race",
        plantedApp(abortingHandler, mcpRequest({ authorization: `Bearer ${TOKEN}` })),
      ],
      [
        "503 post-close",
        plantedApp(
          buildHandler({ admissionGate: gateClosed }).handler,
          mcpRequest({ authorization: `Bearer ${TOKEN}` }),
        ),
      ],
      [
        "400 hostile host",
        plantedApp(
          buildHandler().handler,
          mcpRequest({ authorization: `Bearer ${TOKEN}`, host: "evil.example.com" }),
        ),
      ],
      ["401 no credential", plantedApp(buildHandler().handler, mcpRequest())],
      [
        "403 revoked grant",
        plantedApp(
          buildHandler({
            prisma: buildPrisma({
              grant: { id: GRANT_ID, userId: SUB, clientId: CLIENT_ID, revokedAt: new Date() },
            }),
          }).handler,
          mcpRequest({ authorization: `Bearer ${TOKEN}` }),
        ),
      ],
      [
        "429 quota exhausted",
        plantedApp(
          buildHandler({
            consumeIdentityQuota: async () => ({ ok: false, retryAfterSeconds: 7 }),
          }).handler,
          mcpRequest({ authorization: `Bearer ${TOKEN}` }),
        ),
      ],
      [
        "500 transport failure",
        plantedApp(
          buildHandler({ transport: transport500 }).handler,
          mcpRequest({ authorization: `Bearer ${TOKEN}` }),
        ),
      ],
    ];
    for (const [label, pendingResponse] of cases) {
      const res = await pendingResponse;
      const body = await res.text();
      const length = res.headers.get("content-length");
      // Correct framing = explicit byte-exact length OR no length at all
      // (chunked); the planted/inherited bogus length must never survive.
      expect(
        length === null || Number(length) === Buffer.byteLength(body),
        `${label}: framing`,
      ).toBe(true);
      expect(length).not.toBe(bogus);
    }
  });
});
