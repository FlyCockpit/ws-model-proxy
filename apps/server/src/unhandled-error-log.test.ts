import { describe, expect, it, vi } from "vitest";
import { unhandledErrorLogArgs } from "./unhandled-error-log";

// The module transitively imports @ws-model-proxy/auth/mcp-config (via
// request-log-redaction), which binds to the validated server env — mock
// it like the other server tests (no real .env needed here).
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_URL: "https://proxy.example.com",
    CORS_ORIGIN: undefined,
  },
}));

/**
 * L19 (server catch, pass 10): an error escaping ANY route into
 * app.onError — auth paths, non-auth paths, and the pre-dispatch
 * createContext failure — logs the constructor name ONLY. Prisma
 * messages embed SQL; stacks leak internals; the pass-5 raw-stack
 * branch for non-auth paths is removed (coordinator ruling).
 */

class SentinelPrismaLikeError extends Error {
  constructor() {
    super(
      'Invalid `prisma.session.findUnique()` invocation: SELECT "SECRET-TOKEN-VALUE" FROM "Session"',
    );
    this.name = "SentinelPrismaLikeError";
  }
}

describe("unhandledErrorLogArgs", () => {
  it("/api/auth path: constructor name only — no sentinel message, no stack", () => {
    const error = new SentinelPrismaLikeError();
    const args = unhandledErrorLogArgs(error, "GET", "/api/auth/get-session", "req1");
    expect(args).toEqual([
      "[server] [req1] Unhandled error on GET /api/auth/get-session: SentinelPrismaLikeError",
    ]);
    for (const arg of args) {
      expect(String(arg)).not.toContain("SECRET-TOKEN-VALUE");
      expect(String(arg)).not.toContain("SELECT");
    }
  });

  it("ALL paths are sanitized — non-auth paths no longer keep the stack (pass-10 ruling)", () => {
    const error = new SentinelPrismaLikeError();
    for (const path of ["/v1/models", "/rpc/x", "/api/authx", "/some/ssr/path", "/"]) {
      const args = unhandledErrorLogArgs(error, "POST", path, "r");
      expect(args).toEqual([
        `[server] [r] Unhandled error on POST ${path}: SentinelPrismaLikeError`,
      ]);
      expect(String(args[0])).not.toContain("SECRET-TOKEN-VALUE");
      expect(String(args[0])).not.toContain("SELECT");
      expect(args.length).toBe(1);
    }
  });

  it("exactly one log argument — no raw error object is ever appended", () => {
    const error = new Error("client_secret=SENTINEL leak");
    const args = unhandledErrorLogArgs(error, "POST", "/v1/chat/completions", "r9");
    expect(args).toHaveLength(1);
    expect(typeof args[0]).toBe("string");
    expect(args[0]).not.toContain("client_secret");
    expect(args[0]).not.toContain("SENTINEL");
  });

  it("non-Error values degrade to typeof, never String(value)", () => {
    const args = unhandledErrorLogArgs("raw SECRET string", "GET", "/api/auth/ok", "r");
    expect(args).toEqual(["[server] [r] Unhandled error on GET /api/auth/ok: string"]);
    const weird = { odd: true, secret: "SENTINEL" };
    expect(unhandledErrorLogArgs(weird, "POST", "/rpc/x", "r2")).toEqual([
      "[server] [r2] Unhandled error on POST /rpc/x: object",
    ]);
  });

  it("pass 13 (R42): /api/auth paths are TRUNCATED — path-segment credentials never interpolated", () => {
    const args = unhandledErrorLogArgs(
      new Error("irrelevant"),
      "GET",
      "/api/auth/reset-password/R42SECRET?callbackURL=/reset",
      "r42",
    );
    expect(args).toEqual(["[server] [r42] Unhandled error on GET /api/auth/reset-password: Error"]);
    expect(String(args[0])).not.toContain("R42SECRET");
    expect(String(args[0])).not.toContain("callbackURL");
    // Deep oauth2 segments truncate uniformly.
    expect(
      unhandledErrorLogArgs(new Error("x"), "POST", "/api/auth/oauth2/token/extra", "r"),
    ).toEqual(["[server] [r] Unhandled error on POST /api/auth/oauth2: Error"]);
  });
});
