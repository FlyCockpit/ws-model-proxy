import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MCP_WELL_KNOWN_PATHS } from "./mcp-discovery";
import { MCP_ENDPOINT_PATH } from "./mcp-rate-limit";
import { MCP_WEB_PAGE_PATHS } from "./mcp-web-page-gate";
import {
  authRouteLogPath,
  isAuthRoutePath,
  oauthRequestLogLine,
  stripsOAuthQuery,
} from "./request-log-redaction";

// mcp-config binds its module-level constants to the validated server env;
// mock it like the other server tests (no real .env needed here).
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_URL: "https://proxy.example.com",
    CORS_ORIGIN: undefined,
    RATE_LIMIT_MCP_POINTS: 120,
    RATE_LIMIT_MCP_DURATION: 60,
  },
}));

describe("request-log redaction (OAuth query stripping)", () => {
  it("flags exactly the /api/auth/oauth2/ prefix family", () => {
    expect(stripsOAuthQuery("/api/auth/oauth2/authorize")).toBe(true);
    expect(stripsOAuthQuery("/api/auth/oauth2/token")).toBe(true);
    expect(stripsOAuthQuery("/api/auth/oauth2/introspect")).toBe(true);
    expect(stripsOAuthQuery("/api/auth/oauth2/")).toBe(true);
    // Near-misses and unrelated paths keep the stock logger behavior.
    expect(stripsOAuthQuery("/api/auth/oauth2")).toBe(false);
    expect(stripsOAuthQuery("/api/auth/sign-in/email")).toBe(false);
    expect(stripsOAuthQuery("/v1/chat/completions")).toBe(false);
    expect(stripsOAuthQuery("/")).toBe(false);
  });

  it("strips the MCP login/consent PAGES for EVERY supported locale (EXACT equality — signed query carriers)", () => {
    // Part H pass 2 (R83/R84 F2): the pages exist under every supported
    // locale, and each spelling carries the signed OAuth query. The set is
    // SHARED with the web-page gate (single source — the two modules cannot
    // drift): whatever the gate admits, the logger strips.
    expect(MCP_WEB_PAGE_PATHS.length).toBeGreaterThanOrEqual(4);
    for (const path of MCP_WEB_PAGE_PATHS) {
      expect(stripsOAuthQuery(path)).toBe(true);
    }
    // Spot-check both pages in both shipped locales.
    expect(stripsOAuthQuery("/en-US/mcp-login")).toBe(true);
    expect(stripsOAuthQuery("/en-US/mcp-consent")).toBe(true);
    expect(stripsOAuthQuery("/es-MX/mcp-login")).toBe(true);
    expect(stripsOAuthQuery("/es-MX/mcp-consent")).toBe(true);
    // Near-miss paths keep the stock behavior: exact equality, not prefix.
    expect(stripsOAuthQuery("/en-US/mcp-loginish")).toBe(false);
    expect(stripsOAuthQuery("/es-MX/mcp-login/extra")).toBe(false);
    expect(stripsOAuthQuery("/en-US/mcp-consent-page")).toBe(false);
    expect(stripsOAuthQuery("/en-US/mcp-login/..")).toBe(false);
    expect(stripsOAuthQuery("/fr-FR/mcp-login")).toBe(false); // unsupported locale
  });

  it("logger wrapper: EVERY-locale page redirect (es-MX) logs pathname only — redaction is flag-independent", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    // Same wrapper shape as the production request-log middleware: the
    // stripsOAuthQuery branch runs BEFORE any feature gate, so the query is
    // stripped with WMP_MCP_ENABLED both on and off (the Spanish sibling of
    // the en-US regression below).
    const app = new Hono<{ Variables: { requestId: string } }>();
    app.use("/*", async (c, next) => {
      c.set("requestId", "ff001122");
      await next();
    });
    app.use("/*", async (c, next) => {
      if (stripsOAuthQuery(c.req.path)) {
        const start = Date.now();
        await next();
        console.log(
          oauthRequestLogLine({
            requestId: c.get("requestId"),
            method: c.req.method,
            path: c.req.path,
            status: c.res.status,
            elapsedMs: Date.now() - start,
          }),
        );
        return;
      }
      await next();
      console.log(`[${c.get("requestId")}] stock ${c.req.url}`);
    });
    for (const page of ["/es-MX/mcp-login", "/es-MX/mcp-consent"]) {
      const query = `?client_id=c&state=${encodeURIComponent("st-SECRET-state")}&code_challenge=cc-SECRET&sig=SECRET-sig&ba_param=client_id&ba_param=scope`;
      // No route handler is mounted for the page itself — any status (404
      // here) is fine; the request-log wrapper already ran.
      await app.request(page + query);
      const lines = logSpy.mock.calls.flat().map(String);
      expect(lines.some((l) => l.includes(page))).toBe(true);
      for (const line of lines) {
        expect(line).not.toContain("?");
        expect(line).not.toContain("state=");
        expect(line).not.toContain("sig=");
        expect(line).not.toContain("SECRET");
      }
      logSpy.mockClear();
    }
  });

  it("strips the /mcp endpoint (L20 reopen, F2: exact + trailing-slash; near-misses keep stock)", () => {
    // Drift pin: the redaction set must track the mounted endpoint path.
    expect(MCP_ENDPOINT_PATH).toBe("/mcp");
    expect(stripsOAuthQuery(MCP_ENDPOINT_PATH)).toBe(true);
    expect(stripsOAuthQuery(`${MCP_ENDPOINT_PATH}/`)).toBe(true);
    expect(stripsOAuthQuery("/mcpish")).toBe(false);
    expect(stripsOAuthQuery("/mcp/extra")).toBe(false);
    expect(stripsOAuthQuery("/some/mcp")).toBe(false);
    expect(stripsOAuthQuery("/")).toBe(false);
  });

  it("emits a line with method + pathname + status + elapsed and NO query, even for a URL with state", () => {
    const line = oauthRequestLogLine({
      requestId: "abcd1234",
      method: "GET",
      path: "/api/auth/oauth2/authorize",
      status: 302,
      elapsedMs: 7,
    });
    expect(line).toBe("[abcd1234] --> GET /api/auth/oauth2/authorize 302 7ms");
    // The line is built from the pathname only — there is no place a query
    // (state, code_challenge, resource) could appear.
    expect(line).not.toContain("?");
    expect(line).not.toContain("state=");
  });

  it("cannot carry query values because the builder only receives the pathname", () => {
    // The server passes c.req.path (never c.req.url) — structural bound.
    // Simulate the worst case: even a path-looking string with a query that
    // a caller might pass has no room for extra segments in the format.
    const line = oauthRequestLogLine({
      requestId: "ff001122",
      method: "POST",
      path: "/api/auth/oauth2/token",
      status: 200,
      elapsedMs: 12,
    });
    expect(line).toBe("[ff001122] --> POST /api/auth/oauth2/token 200 12ms");
  });

  // ------------------------------------------------------------------
  // L20 (pass 4): integration-shaped — the index.ts logger wrapper shape
  // mounted on a Hono app, following a login redirect whose Location
  // carries the signed OAuth query (state / code_challenge / sig).
  // ------------------------------------------------------------------

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logger wrapper: login-page redirect (302 ?state=…&code_challenge=…&sig=…) logs pathname only", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    // Mirrors the index.ts wrapper shape: requestId middleware + the
    // stripsOAuthQuery branch emitting oauthRequestLogLine(c.req.path).
    const app = new Hono<{ Variables: { requestId: string } }>();
    app.use("/*", async (c, next) => {
      c.set("requestId", "ff001122");
      await next();
    });
    app.use("/*", async (c, next) => {
      if (stripsOAuthQuery(c.req.path)) {
        const start = Date.now();
        await next();
        console.log(
          oauthRequestLogLine({
            requestId: c.get("requestId"),
            method: c.req.method,
            path: c.req.path,
            status: c.res.status,
            elapsedMs: Date.now() - start,
          }),
        );
        return;
      }
      await next();
      console.log(`[${c.get("requestId")}] stock ${c.req.url}`);
    });
    app.get("/en-US/mcp-login", (c) =>
      c.redirect(
        `/en-US/mcp-login?state=${encodeURIComponent("st-SECRET-state")}&code_challenge=${encodeURIComponent("cc-SECRET-challenge")}&sig=SECRET-sig`,
      ),
    );

    const res = await app.request(
      `/en-US/mcp-login?state=${encodeURIComponent("st-SECRET-state")}&code_challenge=${encodeURIComponent("cc-SECRET-challenge")}&sig=SECRET-sig`,
    );
    expect(res.status).toBe(302);

    const lines = logSpy.mock.calls.flat().map(String);
    expect(lines.some((l) => l.includes("/en-US/mcp-login"))).toBe(true);
    for (const line of lines) {
      expect(line).not.toContain("?");
      expect(line).not.toContain("state=");
      expect(line).not.toContain("code_challenge");
      expect(line).not.toContain("sig=");
    }
  });

  it("logger wrapper: near-miss page path keeps the stock line (full URL, redaction off)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const app = new Hono();
    app.use("/*", async (c, next) => {
      if (stripsOAuthQuery(c.req.path)) {
        await next();
        console.log(
          oauthRequestLogLine({
            requestId: "-",
            method: c.req.method,
            path: c.req.path,
            status: c.res.status,
            elapsedMs: 1,
          }),
        );
        return;
      }
      await next();
      console.log(`stock ${c.req.url}`);
    });
    app.get("/en-US/mcp-loginish", (c) => c.text("ok"));

    const res = await app.request("/en-US/mcp-loginish?q=v");
    expect(res.status).toBe(200);
    const lines = logSpy.mock.calls.flat().map(String);
    expect(lines.some((l) => l.includes("q=v"))).toBe(true);
  });

  // ------------------------------------------------------------------
  // L20 reopen (Part E pass 2): the three ROOT discovery aliases join the
  // query-stripping set; the fourth stays under the isAuthRoutePath branch.
  // ------------------------------------------------------------------

  it("strips the three ROOT discovery aliases (exact + exact-with-trailing-slash)", () => {
    for (const path of MCP_WELL_KNOWN_PATHS) {
      if (path.startsWith("/api/auth")) continue;
      expect(stripsOAuthQuery(path)).toBe(true);
      expect(stripsOAuthQuery(`${path}/`)).toBe(true);
    }
    expect(stripsOAuthQuery("/.well-known/oauth-protected-resource")).toBe(true);
    expect(stripsOAuthQuery("/.well-known/oauth-protected-resource/mcp")).toBe(true);
    expect(stripsOAuthQuery("/.well-known/oauth-authorization-server/api/auth")).toBe(true);
  });

  it("near-miss well-known spellings keep the stock logger", () => {
    expect(stripsOAuthQuery("/.well-known/oauth-protected-resourceish")).toBe(false);
    expect(stripsOAuthQuery("/.well-known/oauth-protected-resource/mcp/extra")).toBe(false);
    expect(stripsOAuthQuery("/.well-known/oauth-authorization-server/api/authx")).toBe(false);
    expect(stripsOAuthQuery("/.well-known")).toBe(false);
    expect(stripsOAuthQuery("/.well-known/")).toBe(false);
  });

  it("the FOURTH alias stays covered by the /api/auth truncation branch (which runs first)", () => {
    const fourth = MCP_WELL_KNOWN_PATHS.find((p) => p.startsWith("/api/auth"));
    if (!fourth) throw new Error("fourth alias missing from MCP_WELL_KNOWN_PATHS");
    expect(fourth).toBe("/api/auth/.well-known/oauth-authorization-server");
    expect(isAuthRoutePath(fourth)).toBe(true);
    // Truncated to the first three segments with the query ALWAYS dropped —
    // `state`/`code` can never reach the log line on this path either.
    expect(authRouteLogPath(`${fourth}?state=SECRET&code=SECRET`)).toBe("/api/auth/.well-known");
  });

  // The root-alias (and fourth-alias) WRAPPER redaction is verified against
  // the REAL production request-log middleware — mounted by createApp() —
  // in app-order.test.ts (L24), not against a hand-built wrapper fixture.
});

describe("auth-route path truncation (pass 13 / R42)", () => {
  it("3+ segment auth paths truncate to the first three path segments", () => {
    // R42 reproducer: the 4th segment is a live reset-password token.
    expect(authRouteLogPath("/api/auth/reset-password/R42SECRET")).toBe("/api/auth/reset-password");
    // OAuth family truncates uniformly (query already dropped there; deeper
    // segments now dropped too).
    expect(authRouteLogPath("/api/auth/oauth2/authorize")).toBe("/api/auth/oauth2");
    expect(authRouteLogPath("/api/auth/admin/impersonate-user/uid123")).toBe("/api/auth/admin");
  });

  it("exactly-3-segment auth paths are unchanged", () => {
    expect(authRouteLogPath("/api/auth/reset-password")).toBe("/api/auth/reset-password");
    expect(authRouteLogPath("/api/auth/get-session")).toBe("/api/auth/get-session");
    expect(authRouteLogPath("/api/auth/oauth2")).toBe("/api/auth/oauth2");
  });

  it("2-segment auth paths are unchanged", () => {
    expect(authRouteLogPath("/api/auth")).toBe("/api/auth");
    expect(authRouteLogPath("/api/auth/")).toBe("/api/auth/");
  });

  it("the query is ALWAYS dropped for auth paths, even within three segments", () => {
    expect(authRouteLogPath("/api/auth/reset-password/R42SECRET?callbackURL=/reset")).toBe(
      "/api/auth/reset-password",
    );
    expect(authRouteLogPath("/api/auth/sign-in/email?state=SECRET")).toBe("/api/auth/sign-in");
    expect(authRouteLogPath("/api/auth/get-session?")).toBe("/api/auth/get-session");
  });

  it("non-auth paths pass through untouched (query and all)", () => {
    expect(authRouteLogPath("/v1/chat/completions?a=b/deep/secret")).toBe(
      "/v1/chat/completions?a=b/deep/secret",
    );
    // Prefix near-miss: /api/authx is NOT a Better Auth route.
    expect(authRouteLogPath("/api/authx/reset-password/TOKEN")).toBe(
      "/api/authx/reset-password/TOKEN",
    );
    expect(authRouteLogPath("/")).toBe("/");
  });

  it("isAuthRoutePath flags exactly the /api/auth family", () => {
    expect(isAuthRoutePath("/api/auth")).toBe(true);
    expect(isAuthRoutePath("/api/auth/")).toBe(true);
    expect(isAuthRoutePath("/api/auth/reset-password/R42SECRET")).toBe(true);
    expect(isAuthRoutePath("/api/authx/reset-password")).toBe(false);
    expect(isAuthRoutePath("/apifoo")).toBe(false);
  });

  it("wrapper shape: auth route request logs the truncated path on BOTH lines, never the token or query", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    // Mirrors the index.ts wrapper (pass 13): isAuthRoutePath branch first,
    // truncated `<--`/`-->` pair; MCP-page branch; stock otherwise.
    const app = new Hono<{ Variables: { requestId: string } }>();
    app.use("/*", async (c, next) => {
      c.set("requestId", "ff001122");
      await next();
    });
    app.use("/*", async (c, next) => {
      const reqId = c.get("requestId");
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
      await next();
      console.log(`[${reqId}] stock ${c.req.url}`);
    });
    app.get("/api/auth/reset-password/:token", (c) => c.redirect("/reset?token=R42SECRET"));

    const res = await app.request("/api/auth/reset-password/R42SECRET?callbackURL=/reset");
    expect(res.status).toBe(302);
    const lines = logSpy.mock.calls.flat().map(String);
    expect(lines.some((l) => l.includes("/api/auth/reset-password"))).toBe(true);
    for (const line of lines) {
      expect(line).not.toContain("R42SECRET");
      expect(line).not.toContain("callbackURL");
      expect(line).not.toContain("?");
    }
  });
});
