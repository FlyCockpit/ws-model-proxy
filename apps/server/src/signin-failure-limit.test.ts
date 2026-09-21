import { createHash } from "node:crypto";
import { Hono } from "hono";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    RATE_LIMIT_AUTH_POINTS: 3,
    RATE_LIMIT_AUTH_DURATION: 60,
    RATE_LIMIT_AUTH_BLOCK_DURATION: 120,
    RATE_LIMIT_SIGNIN_FAILURE_POINTS: 10,
    RATE_LIMIT_SIGNIN_FAILURE_DURATION: 900,
    RATE_LIMIT_SIGNIN_FAILURE_BLOCK_DURATION: 600,
    RATE_LIMIT_SIGNUP_POINTS: 3,
    RATE_LIMIT_SIGNUP_DURATION: 3600,
    RATE_LIMIT_SIGNUP_BLOCK_DURATION: 3600,
    RATE_LIMIT_RPC_POINTS: 5,
    RATE_LIMIT_RPC_DURATION: 60,
    RATE_LIMIT_EMAIL_RECIPIENT_POINTS: 3,
    RATE_LIMIT_EMAIL_RECIPIENT_DURATION: 3600,
    RATE_LIMIT_EMAIL_RECIPIENT_BLOCK_DURATION: 0,
    RATE_LIMIT_SIGNUP_RECIPIENT_POINTS: 6,
    TRUST_PROXY_HOPS: undefined,
  },
}));

vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: () => ({ remote: { address: "10.0.0.1" } }),
}));

const { signinFailureKey } = await import("./rate-limit.js");
const { SIGNIN_FAILURE_PATH, signinFailureLimit } = await import("./signin-failure-limit.js");

function buildApp(
  limiter: RateLimiterMemory,
  response: () => { status: 200 | 400 | 401 | 403 | 429; code?: string },
) {
  const app = new Hono();
  let credentialChecks = 0;
  app.use(SIGNIN_FAILURE_PATH, signinFailureLimit(limiter));
  app.post(SIGNIN_FAILURE_PATH, async (c) => {
    credentialChecks += 1;
    // This assertion is implicit in every test: a body-consuming limiter would
    // make the real auth handler unable to read its request.
    if (c.req.header("content-type") === "application/x-www-form-urlencoded") {
      await c.req.raw.formData();
    } else {
      await c.req.raw.json();
    }
    const { code, status } = response();
    return c.json(code ? { code } : { ok: true }, status);
  });
  return { app, credentialChecks: () => credentialChecks };
}

function signIn(app: Hono, email: string, type = "application/json") {
  const body =
    type === "application/x-www-form-urlencoded"
      ? new URLSearchParams({ email, password: "wrong" }).toString()
      : JSON.stringify({ email, password: "wrong" });
  return app.request(SIGNIN_FAILURE_PATH, {
    method: "POST",
    headers: { "content-type": type },
    body,
  });
}

function memoryLimiter(points = 3) {
  return new RateLimiterMemory({
    keyPrefix: "test-signin-fail",
    points,
    duration: 900,
    blockDuration: 600,
  });
}

describe("signinFailureKey", () => {
  it("hashes a normalized address instead of storing it as limiter state", () => {
    const key = signinFailureKey(" Victim@Example.com ");
    expect(key).toBe(`em:${createHash("sha256").update("victim@example.com").digest("base64url")}`);
    expect(key).not.toContain("victim@example.com");
    expect(signinFailureKey("victim@example.com")).toBe(key);
  });
});

describe("signinFailureLimit", () => {
  it("blocks rotating-IP password guesses against one address before another credential check", async () => {
    const { app, credentialChecks } = buildApp(memoryLimiter(), () => ({
      status: 401,
      code: "INVALID_EMAIL_OR_PASSWORD",
    }));

    for (const email of ["victim@example.com", "VICTIM@example.com", " victim@example.com "]) {
      expect((await signIn(app, email)).status).toBe(401);
    }

    const blocked = await signIn(app, "victim@example.com");
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({
      error: "Too many attempts. Please wait a moment and try again.",
    });
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
    expect(credentialChecks()).toBe(3);
    expect((await signIn(app, "other@example.com")).status).toBe(401);
  });

  it("shares the failure budget across JSON and form submissions", async () => {
    const { app } = buildApp(memoryLimiter(), () => ({
      status: 401,
      code: "INVALID_EMAIL_OR_PASSWORD",
    }));
    expect(
      (await signIn(app, "victim@example.com", "application/x-www-form-urlencoded")).status,
    ).toBe(401);
    expect((await signIn(app, "victim@example.com")).status).toBe(401);
    expect((await signIn(app, "victim@example.com")).status).toBe(401);
    expect(
      (await signIn(app, "victim@example.com", "application/x-www-form-urlencoded")).status,
    ).toBe(429);
  });

  it.each([200, 400, 403, 429] as const)(
    "refunds a %i response so it cannot become a lockout lever",
    async (status) => {
      const limiter = memoryLimiter(2);
      const { app } = buildApp(limiter, () => ({ status }));

      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await signIn(app, "victim@example.com")).status).toBe(status);
      }
      expect((await limiter.get(signinFailureKey("victim@example.com")))?.consumedPoints ?? 0).toBe(
        0,
      );
    },
  );

  it("refunds a valid-password session creation failure", async () => {
    const limiter = memoryLimiter(2);
    const { app } = buildApp(limiter, () => ({
      status: 401,
      // Better Auth's signInEmail route emits this after password verification
      // if its internalAdapter.createSession call returns no session.
      code: "FAILED_TO_CREATE_SESSION",
    }));

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await signIn(app, "owner@example.com")).status).toBe(401);
    }
    expect((await limiter.get(signinFailureKey("owner@example.com")))?.consumedPoints ?? 0).toBe(0);
  });

  it("fails open when this additive limiter is unavailable", async () => {
    const error = new Error("store unavailable");
    const consume = vi.fn().mockRejectedValue(error);
    const reward = vi.fn();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = new Hono();
    app.use(SIGNIN_FAILURE_PATH, signinFailureLimit({ points: 3, consume, reward }));
    app.post(SIGNIN_FAILURE_PATH, (c) => c.json({ code: "INVALID_EMAIL_OR_PASSWORD" }, 401));

    expect((await signIn(app, "victim@example.com")).status).toBe(401);
    expect(reward).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "[rate-limit] signin-failure limiter error, failing open: (Error)",
    );
    expect(log).not.toHaveBeenCalledWith(expect.anything(), error);
    log.mockRestore();
  });
});
