import {
  MCP_CONSENT_PAGE_PATH_DEFAULT,
  MCP_LOGIN_PAGE_PATH_DEFAULT,
} from "@ws-model-proxy/auth/mcp-config";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("strips the MCP login/consent PAGES (EXACT equality — signed query carriers)", () => {
    expect(stripsOAuthQuery(MCP_LOGIN_PAGE_PATH_DEFAULT)).toBe(true);
    expect(stripsOAuthQuery(MCP_CONSENT_PAGE_PATH_DEFAULT)).toBe(true);
    // Near-miss paths keep the stock behavior: exact equality, not prefix.
    expect(stripsOAuthQuery("/en-US/mcp-loginish")).toBe(false);
    expect(stripsOAuthQuery("/en-US/mcp-login/extra")).toBe(false);
    expect(stripsOAuthQuery("/en-US/mcp-consent-page")).toBe(false);
    expect(stripsOAuthQuery("/en-US/mcp-login/..")).toBe(false);
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
