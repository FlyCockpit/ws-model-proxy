import { createHash } from "node:crypto";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * L19 TERMINAL log-sanitizer policy — bucket C + F1a regressions (pass 6).
 *
 * Test 8 (bucket C + B1 terminal guarantee): the REAL prisma adapter with
 * `advanced.database.joins: true` executes the session→user join NATIVELY
 * (the join clause is passed through to the adapter — core factory.mjs
 * :561/:609 — and no separate fallback user query runs), and when the
 * joined key is absent so factory.mjs:191-195 still reaches
 * handleFallbackJoin and that user lookup FAILS, the raw Error must NOT
 * reach the console (bucket B shim intercepts Error-first console calls).
 * Both the real /api/auth/get-session and /api/auth/oauth2/authorize
 * handlers are exercised.
 *
 * Test 9 (F1a regression): a storage failure on the real list-sessions
 * route (logger.error(raw Error) first-arg shape — the pass-5 bridge
 * leaked `String(error)`) must produce only `[auth] error (<ctor>)` and
 * the sentinel must appear in NO console output.
 *
 * Synthetic credentials only; no database connection. Every console
 * method is captured through the shim (spies installed BEFORE the shim so
 * the shim's "originals" are the spies).
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

import { sanitizedApiErrorLogLine } from "../../../packages/auth/src/api-error-logging";
import {
  MESSAGE_REDACTED_MARKER,
  resolveAuthLogCall,
} from "../../../packages/auth/src/auth-logger-bridge";
import { resolveMcpPlugins } from "../../../packages/auth/src/mcp-plugins";
import { installBetterCallErrorLogShim } from "./better-call-error-log-shim";
import {
  authRouteLogPath,
  isAuthRoutePath,
  oauthRequestLogLine,
  stripsOAuthQuery,
} from "./request-log-redaction";
import { unhandledErrorLogArgs } from "./unhandled-error-log";

const BASE = "https://proxy.example.com";
const CANONICAL = `${BASE}/mcp`;
const AUTHORIZE = "/api/auth/oauth2/authorize";
const CLIENT = "parity-client";
const CALLBACK = "https://client.example.com/callback";
const VERIFIER = "parity-pkce-verifier-at-least-forty-three-characters";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const SECRET = "LOGPOLICY-SECRET-TOKEN-9f2c";

const output: unknown[][] = [];

const storageError = () =>
  new Error(`relation failure SELECT secret WHERE token='${SECRET}' AND password='${SECRET}'`);

beforeAll(() => {
  for (const method of ["error", "warn", "log", "info", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      output.push([method, ...args]);
    });
  }
  installBetterCallErrorLogShim();
});

beforeEach(() => {
  output.length = 0;
  grants.findUnique.mockReset().mockResolvedValue(null);
  grants.create.mockReset().mockResolvedValue({ id: "parity-grant-row", revokedAt: null });
});

afterAll(() => {
  vi.restoreAllMocks();
});

const logText = () =>
  output
    .map((call) =>
      call
        .map((value) =>
          value instanceof Error ? `${value.message} ${value.stack}` : String(value),
        )
        .join(" "),
    )
    .join("\n");

/** Terminal policy assertions: sentinel absent, no raw Errors, no stacks. */
function assertNoRawErrorOutput() {
  expect(logText()).not.toContain(SECRET);
  expect(output.flat().some((value) => value instanceof Error)).toBe(false);
  expect(logText()).not.toContain(" at ");
}

function buildMemoryApp(opts: { mountRequestLog?: boolean; injectRequestFailure?: boolean } = {}) {
  const memory: Record<string, Record<string, unknown>[]> = {
    oauthAccessToken: [],
    oauthRefreshToken: [],
    oauthConsent: [],
    oauthClientAssertion: [],
    jwks: [],
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
        skipConsent: true,
        requirePKCE: true,
        disabled: false,
      },
    ],
  };
  const auth = betterAuth({
    baseURL: BASE,
    secret: "parity-test-secret-at-least-thirty-two-characters",
    database: memoryAdapter(memory),
    emailAndPassword: { enabled: true },
    advanced: { disableOriginCheck: false },
    logger: {
      log(level, message, ...args) {
        const call = resolveAuthLogCall(level, message, args);
        if (call) console[call.method](...call.args);
      },
    },
    onAPIError: {
      onError(error: unknown) {
        const line = sanitizedApiErrorLogLine(error);
        if (line) console.error(line);
      },
    },
    plugins: resolveMcpPlugins({ enabled: true, baseUrl: BASE }),
  });
  const app = new Hono();
  if (opts.mountRequestLog) {
    // Mirrors the production index.ts logger wrapper (pass 13): EVERY
    // /api/auth path logs a truncated `<--`/`-->` pair (first three path
    // segments, query dropped); MCP login/consent pages keep the
    // query-stripped line; everything else keeps the stock logger.
    app.use("/*", async (c, next) => {
      const reqId = "logpolicy";
      if (isAuthRoutePath(c.req.path)) {
        const logPath = authRouteLogPath(c.req.path);
        const start = Date.now();
        console.log(`[${reqId}] <-- ${c.req.method} ${logPath}`);
        await next();
        console.log(
          oauthRequestLogLine({
            requestId: reqId,
            method: c.req.method,
            path: logPath,
            status: c.res.status,
            elapsedMs: Date.now() - start,
          }),
        );
        return;
      }
      if (stripsOAuthQuery(c.req.path)) {
        const start = Date.now();
        await next();
        console.log(
          oauthRequestLogLine({
            requestId: reqId,
            method: c.req.method,
            path: c.req.path,
            status: c.res.status,
            elapsedMs: Date.now() - start,
          }),
        );
        return;
      }
      const logFn = (message: string, ...rest: string[]) => {
        console.log(`[${reqId}] ${message}`, ...rest);
      };
      return logger(logFn)(c, next);
    });
  }
  app.onError((error, c) => {
    console.error(...unhandledErrorLogArgs(error, c.req.method, c.req.path, "logpolicy"));
    return c.json({ error: "Internal error" }, 500);
  });
  if (opts.injectRequestFailure) {
    // Pass-13 probe (b): request-phase failure mounted BEFORE the auth
    // handler; the throw escapes to app.onError whose line is built by
    // unhandledErrorLogArgs (the truncation sink under test).
    app.use("/api/auth/reset-password/*", () => {
      throw new Error("R42 request failure");
    });
  }
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  return { app, auth, memory };
}

async function login(auth: ReturnType<typeof buildMemoryApp>["auth"]) {
  const response = await auth.api.signUpEmail({
    body: {
      name: "Log Policy",
      email: "logpolicy@example.test",
      password: "logpolicy-password-1A",
    },
    asResponse: true,
  });
  expect(response.status).toBe(200);
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}

describe("bucket C — prisma adapter native join + B1 terminal guarantee", () => {
  function buildPrismaApp({
    sessionRow,
    userFind,
  }: {
    sessionRow: Record<string, unknown> | null;
    userFind: ReturnType<typeof vi.fn>;
  }) {
    const sessionFind = vi.fn().mockResolvedValue(sessionRow);
    const resourceRow = {
      id: "logpolicy-resource-row",
      identifier: CANONICAL,
      disabled: false,
      allowedScopes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const clientRow = {
      id: "logpolicy-client-row",
      clientId: CLIENT,
      tokenEndpointAuthMethod: "none",
      redirectUris: [CALLBACK],
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      scopes: ["mcp:read", "mcp:write", "offline_access"],
      skipConsent: true,
      requirePKCE: true,
      disabled: false,
    };
    const linkRow = {
      id: "logpolicy-link-row",
      clientId: CLIENT,
      resourceId: CANONICAL,
      createdAt: new Date(),
    };
    const auth = betterAuth({
      baseURL: BASE,
      secret: "parity-test-secret-at-least-thirty-two-characters",
      database: prismaAdapter(
        {
          session: { findFirst: sessionFind },
          user: { findFirst: userFind },
          account: { findFirst: vi.fn().mockResolvedValue(null) },
          oauthResource: { findFirst: vi.fn().mockResolvedValue(resourceRow) },
          oauthClient: { findFirst: vi.fn().mockResolvedValue(clientRow) },
          oauthClientResource: {
            findFirst: vi.fn().mockResolvedValue(linkRow),
            findMany: vi.fn().mockResolvedValue([linkRow]),
          },
        },
        { provider: "postgresql" },
      ),
      emailAndPassword: { enabled: true },
      // THE root fix under test: native joins ON.
      advanced: { database: { joins: true }, disableOriginCheck: false },
      logger: {
        log(level, message, ...args) {
          const call = resolveAuthLogCall(level, message, args);
          if (call) console[call.method](...call.args);
        },
      },
      onAPIError: {
        onError(error: unknown) {
          const line = sanitizedApiErrorLogLine(error);
          if (line) console.error(line);
        },
      },
      plugins: resolveMcpPlugins({ enabled: true, baseUrl: BASE }),
    });
    const app = new Hono();
    app.onError((error, c) => {
      console.error(...unhandledErrorLogArgs(error, c.req.method, c.req.path, "logpolicy"));
      return c.json({ error: "Internal error" }, 500);
    });
    app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
    return { app, auth, sessionFind };
  }

  async function memoryFixtureRows() {
    const fixture = buildMemoryApp();
    const cookie = await login(fixture.auth);
    const session = fixture.memory.session?.[0];
    const user = fixture.memory.user?.[0];
    if (!session || !user) throw new Error("memory fixture missing session/user rows");
    return { cookie, session, user };
  }

  it("8a — session→user join executes NATIVELY: join clause reaches the adapter, no fallback user query", async () => {
    const { cookie, session, user } = await memoryFixtureRows();
    const userFind = vi.fn();
    const { app, sessionFind } = buildPrismaApp({
      sessionRow: { ...session, user },
      userFind,
    });
    const res = await app.request(`${BASE}/api/auth/get-session`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user?: { id?: string } | null };
    expect(body.user?.id).toBe(user.id);
    // Native join: with advanced.database.joins set, the core factory
    // keeps passJoinToAdapter=true (:561) and the INSTALLED prisma adapter
    // translates the join clause into a prisma include — the db-level
    // session.findFirst select carries the "user" relation key...
    const joinedCall = sessionFind.mock.calls.find(
      (call) => (call[0]?.select as Record<string, unknown> | undefined)?.user,
    );
    expect(joinedCall).toBeTruthy();
    // ...and the fallback path (a SEPARATE user query) never ran.
    expect(userFind).not.toHaveBeenCalled();
    assertNoRawErrorOutput();
  });

  it("8b — joined key absent + failing user lookup on /api/auth/get-session: no raw Error reaches the console", async () => {
    const { cookie, session } = await memoryFixtureRows();
    const userFind = vi.fn().mockRejectedValue(storageError());
    const { app } = buildPrismaApp({ sessionRow: { ...session }, userFind });
    const res = await app.request(`${BASE}/api/auth/get-session`, { headers: { cookie } });
    expect(res.status).toBe(500);
    // factory.mjs:191-195 reaches handleFallbackJoin (joined key absent) →
    // the separate user lookup rejects → the raw Error would hit the
    // console; bucket B intercepts it.
    expect(userFind).toHaveBeenCalled();
    expect(logText()).toContain("error (sanitized): Error");
    assertNoRawErrorOutput();
  });

  it("8c — failing user lookup on the real /api/auth/oauth2/authorize handler: no raw Error reaches the console", async () => {
    const { cookie, session } = await memoryFixtureRows();
    const userFind = vi.fn().mockRejectedValue(storageError());
    const { app } = buildPrismaApp({ sessionRow: { ...session }, userFind });
    const res = await app.request(
      `${BASE}${AUTHORIZE}?${new URLSearchParams({
        response_type: "code",
        client_id: CLIENT,
        redirect_uri: CALLBACK,
        scope: "mcp:read",
        resource: CANONICAL,
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
      })}`,
      { headers: { cookie } },
    );
    expect(userFind).toHaveBeenCalled();
    expect(res.status).toBe(302); // session resolution failed → login redirect (R28 probe parity)
    assertNoRawErrorOutput();
  });
});

describe("bucket tests 9 — F1a end-to-end list-sessions storage-failure regression", () => {
  it("list-sessions storage failure: sentinel appears in NO console output; ctor-only bridge line", async () => {
    const fixture = buildMemoryApp();
    const cookie = await login(fixture.auth);
    const ctx = await fixture.auth.$context;
    vi.spyOn(ctx.internalAdapter, "listSessions").mockRejectedValue(storageError());
    const res = await fixture.app.request(`${BASE}/api/auth/list-sessions`, {
      headers: { cookie },
    });
    expect(res.status).toBe(500);
    // The pass-5 bridge leaked `[auth] Error: <error.message>` (raw Error
    // first arg stringified); the TERMINAL policy emits the ctor label only.
    expect(logText()).toContain("[auth] error (Error)");
    assertNoRawErrorOutput();
  });
});

describe("pass 7/9 — origin-check encoded-key Referer regression (R29/R30, v3 closure)", () => {
  it("crafted Referer ?%73tate=…&%73ig=… → 403; sentinel in NO console output; [auth] line whole-message redacted", async () => {
    const { app } = buildMemoryApp();
    const response = await app.request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "sentinel-cookie=present",
        referer: `https://untrusted.example/login?%73tate=${SECRET}&%73ig=${SECRET}`,
      },
      body: JSON.stringify({
        email: "logpolicy@example.test",
        password: "test-password-long-enough",
      }),
    });
    expect(response.status).toBe(403);
    // The installed origin-check middleware logs `Invalid origin:
    // <referer>` through the bridge. Under TERMINAL POLICY v3 the referer
    // carries structural characters (`://`, `=`), so the WHOLE message is
    // redacted — no `Invalid origin:` text, no host, no query fragments.
    const authLines = output.map((call) => String(call[1])).filter((l) => l.startsWith("[auth] "));
    expect(authLines.length).toBeGreaterThan(0);
    expect(authLines.some((line) => line.includes(MESSAGE_REDACTED_MARKER))).toBe(true);
    expect(logText()).not.toContain("Invalid origin:");
    expect(logText()).not.toContain("untrusted.example");
    assertNoRawErrorOutput();
  });
});

describe("pass 9 — origin-check TERMINAL v3 regressions (R31/R32/R33 convergent shapes)", () => {
  // Every reviewer shape from R31/R32 (quote/angle-bracket terminators
  // after a known key, whitespace-split values, case-variant schemes,
  // userinfo credentials) and all 20 R33 shapes (protocol-relative,
  // backslash schemes, single/no slash, tab-in-key/host/scheme, CR/LF
  // within keys, multi-token values, fragment-only, orphan-URL reentry).
  // Each must 403 with the sentinel absent from EVERY captured console
  // call; under v3 every one of these Referers carries a structural
  // trigger and the [auth] line is the whole-message redaction marker.
  const SHAPES: ReadonlyArray<[label: string, referer: string]> = [
    ["R33 protocol-relative query", `//evil.example/cb?scope=${SECRET}`],
    ["R33 protocol-relative credentials", `//user:${SECRET}@evil.example/cb?state=x`],
    ["R33 protocol-relative fragment", `//evil.example/cb#${SECRET}`],
    ["R33 backslash scheme query", String.raw`https:\\evil.example/cb?scope=${SECRET}`],
    [
      "R33 backslash scheme credentials",
      String.raw`https:\\user:${SECRET}@evil.example/cb?state=x`,
    ],
    ["R33 backslash scheme fragment", String.raw`https:\\evil.example/cb#${SECRET}`],
    ["R33 single slash", `https:/evil.example/cb?scope=${SECRET}`],
    ["R33 no slash", `https:evil.example/cb?scope=${SECRET}`],
    ["R33 tab within known key", `https://evil.example/cb?sta\tte=${SECRET}`],
    ["R33 tab within host", `https://ev\til.example/cb?scope=${SECRET}`],
    ["R33 tab within scheme", `ht\ttps://evil.example/cb?scope=${SECRET}`],
    ["R33 nonempty state then space", `https://evil.example/cb?state=public ${SECRET}`],
    ["R33 nonempty state then tab", `https://evil.example/cb?state=public\t${SECRET}`],
    ["R33 quoted state then space", `https://evil.example/cb?state=' ${SECRET}`],
    ["R33 fragment then space", `https://evil.example/cb# ${SECRET}`],
    ["R33 state with two words", `https://evil.example/cb?state= public ${SECRET}`],
    ["R33 userinfo with space", `https://user: ${SECRET}@evil.example/cb?state=x`],
    [
      "R33 nested marker plus whitespace",
      `https://evil.example/cb?state=[query-redacted][fragment-redacted] ${SECRET}`,
    ],
    [
      "R33 orphan URL reentry past fragment marker",
      `https://evil.example/cb?state=#f https://value.example/${SECRET}`,
    ],
    [
      "R33 orphan URL with query reentry",
      `https://evil.example/cb?state=#f https://value.example/${SECRET}?state=x`,
    ],
    ["apostrophe terminator", `https://evil.example/cb?state='${SECRET}`],
    ["double-quote terminator", `https://evil.example/cb?state="${SECRET}`],
    ["less-than terminator", `https://evil.example/cb?state=<${SECRET}`],
    ["greater-than terminator", `https://evil.example/cb?state=>${SECRET}`],
    ["space-separated value", `https://evil.example/cb?state= ${SECRET}`],
    ["uppercase scheme with query", `HTTPS://evil.example/cb?other=${SECRET}`],
    ["mixed-case scheme, fragment only", `hTtPs://evil.example/cb#${SECRET}`],
    ["userinfo credentials", `https://user:${SECRET}@evil.example/cb?state=x`],
  ];

  it.each(SHAPES)(
    "reviewer Referer shape %s: 403, sentinel in NO console output, whole-message redaction",
    async (_label, referer) => {
      const { app } = buildMemoryApp();
      const response = await app.request(`${BASE}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "sentinel-cookie=present",
          referer,
        },
        body: JSON.stringify({
          email: "logpolicy@example.test",
          password: "test-password-long-enough",
        }),
      });
      expect(response.status).toBe(403);
      // The installed origin-check middleware logs `Invalid origin:
      // <referer>` through the bridge. Before pass 9 each of these shapes
      // evaded the partial scrubber (terminator-delimited values,
      // case-variant/protocol-relative/backslash schemes, control-char key
      // splits, multi-token values). v3 redacts the WHOLE message: the
      // [auth] line is exactly the marker — no host, no query, no prefix.
      const authLines = output
        .map((call) => String(call[1]))
        .filter((l) => l.startsWith("[auth] "));
      expect(authLines.length).toBeGreaterThan(0);
      expect(authLines.some((line) => line.includes(MESSAGE_REDACTED_MARKER))).toBe(true);
      expect(authLines.every((line) => !line.includes("evil.example"))).toBe(true);
      expect(logText()).not.toContain("Invalid origin:");
      assertNoRawErrorOutput();
    },
  );

  // R33's JSON callbackURL CR/LF path: the callbackURL arrives in the JSON
  // BODY (not the Referer) with a CR embedded in the key spelling —
  // `Invalid callbackURL: <url>` is logged through the same bridge.
  it.each([
    ["CR within key (JSON callbackURL shape)", `https://evil.example/cb?sta\rte=${SECRET}`],
    ["LF within key (JSON callbackURL shape)", `https://evil.example/cb?sta\nte=${SECRET}`],
    ["tab within key (JSON callbackURL shape)", `https://evil.example/cb?sta\tte=${SECRET}`],
  ])(
    "JSON callbackURL shape %s: sentinel in NO console output, whole-message redaction",
    async (_label, callbackURL) => {
      const { app } = buildMemoryApp();
      await app.request(`${BASE}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "sentinel-cookie=present",
          referer: BASE,
        },
        body: JSON.stringify({
          email: "logpolicy@example.test",
          password: "test-password-long-enough",
          callbackURL,
        }),
      });
      // Whatever the routing outcome (403 origin/callback rejection or the
      // credential failure), the sentinel must appear in NO console call.
      const authLines = output
        .map((call) => String(call[1]))
        .filter((l) => l.startsWith("[auth] "));
      expect(authLines.length).toBeGreaterThan(0);
      expect(authLines.some((line) => line.includes(MESSAGE_REDACTED_MARKER))).toBe(true);
      expect(authLines.every((line) => !line.includes("evil.example"))).toBe(true);
      assertNoRawErrorOutput();
    },
  );
});

describe("pass 12 — R40 path-carried credential regression (single-slash trigger)", () => {
  // R40 evidence: a credential carried in a URL PATH —
  // /api/auth/reset-password/<token> — contains none of the pass-11
  // triggers and passed verbatim through the bridge, while the installed
  // reset-password handler treats that path segment as a live token.
  // The pass-12 trigger (ANY single slash) closes the class: every URL,
  // absolute path, and relative reference requires a slash or a colon.
  it("synthetic string rejection carrying a path credential through the real list-sessions handler: sentinel absent, whole-message redaction", async () => {
    const fixture = buildMemoryApp();
    const cookie = await login(fixture.auth);
    const ctx = await fixture.auth.$context;
    const carrier = "/api/auth/reset-password/R40SECRET";
    vi.spyOn(ctx.internalAdapter, "listSessions").mockRejectedValue(carrier);
    const res = await fixture.app.request(`${BASE}/api/auth/list-sessions`, {
      headers: { cookie },
    });
    expect(res.status).toBe(500);
    // The rejected string flows as the logger's string first arg; the
    // single slash now triggers whole-message redaction.
    expect(logText()).toContain(`[auth] error ${MESSAGE_REDACTED_MARKER}`);
    expect(logText()).not.toContain("R40SECRET");
    expect(logText()).not.toContain(carrier);
    assertNoRawErrorOutput();
  });

  it("the installed reset-password route extracts its credential from a single-slash path (live-token proof)", async () => {
    const fixture = buildMemoryApp();
    const ctx = await fixture.auth.$context;
    const lookup = vi.spyOn(ctx.internalAdapter, "findVerificationValue").mockResolvedValue(null);
    const res = await fixture.app.request(
      `${BASE}/api/auth/reset-password/R40SECRET?callbackURL=/reset`,
    );
    // The installed handler parsed the path segment as the verification
    // token — it IS a credential carrier, which is why the bridge must
    // redact any message carrying such a path.
    expect(lookup).toHaveBeenCalledWith("reset-password:R40SECRET");
    expect(res.status).toBe(302);
    assertNoRawErrorOutput();
  });
});

describe("pass 13 — R42 request-log + unhandled-error path truncation", () => {
  // R42 evidence (.review-loop/r42-path-probes.txt): the production
  // request logger printed `/api/auth/reset-password/R42SECRET?callbackURL=/reset`
  // VERBATIM on both the `<--` and `-->` lines, and app.onError's
  // `[server]` line interpolated the credential-bearing path — while the
  // installed handler treats the path segment as a live token (pass-12
  // live-token proof). Pass 13 truncates ALL /api/auth request-log and
  // unhandled-error paths to the first three path segments (query
  // dropped). Synthetic credentials only.
  it("successful reset-password GET: log lines carry the endpoint but NEVER the token or query", async () => {
    const fixture = buildMemoryApp({ mountRequestLog: true });
    const ctx = await fixture.auth.$context;
    const lookup = vi.spyOn(ctx.internalAdapter, "findVerificationValue").mockResolvedValue({
      id: "r42-reset",
      identifier: "reset-password:R42SECRET",
      value: "u1",
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await fixture.app.request(
      `${BASE}/api/auth/reset-password/R42SECRET?callbackURL=/reset`,
    );
    // The handler accepted the path token as a live verification value.
    expect(lookup).toHaveBeenCalledWith("reset-password:R42SECRET");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("token=R42SECRET");
    const lines = output.map((call) => call.map(String).join(" ")).join("\n");
    // The endpoint IS logged (correlation kept), the credential is NOT.
    expect(lines).toContain("<-- GET /api/auth/reset-password");
    expect(lines).toContain("--> GET /api/auth/reset-password 302");
    expect(lines).not.toContain("R42SECRET");
    expect(lines).not.toContain("callbackURL");
    assertNoRawErrorOutput();
  });

  it("request-phase exception on the same path: the [server] line carries no token", async () => {
    const fixture = buildMemoryApp({ mountRequestLog: true, injectRequestFailure: true });
    const res = await fixture.app.request(
      `${BASE}/api/auth/reset-password/R42SECRET?callbackURL=/reset`,
    );
    expect(res.status).toBe(500);
    const errorLines = output
      .filter((call) => call[0] === "error")
      .map((call) => call.map(String).join(" "))
      .join("\n");
    expect(errorLines).toContain("[server]");
    expect(errorLines).toContain("Unhandled error on GET /api/auth/reset-password: Error");
    expect(errorLines).not.toContain("R42SECRET");
    expect(errorLines).not.toContain("callbackURL");
    assertNoRawErrorOutput();
  });
});
