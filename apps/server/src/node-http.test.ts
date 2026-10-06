import { Hono } from "hono";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  // rate-limit.ts builds its limiters at import from the built-in table.
  env: {
    BETTER_AUTH_URL: "https://proxy.example.com/app",
    NODE_ENV: "test",
    WMP_RATE_LIMIT_SCALE: 1,
  },
}));
vi.mock("@ws-model-proxy/api/nodes/enroll-exchange", () => ({
  exchangeEnrollmentCode: vi.fn(),
  findEnrollmentCodeOwner: vi.fn(),
}));
vi.mock("./client-ip.js", () => ({ resolveClientIp: () => "203.0.113.9" }));

const { installScript, registerNodeHttpRoutes, CLI_SOURCE } = await import("./node-http.js");

const CODE = `wsmp_enr_${"A".repeat(26)}`;
const KEY = `B${"A".repeat(85)}A`;
const body = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ code: CODE, identityPublicKey: KEY, slug: "desk-01", ...overrides });

function limiter(points: number) {
  return new RateLimiterMemory({ keyPrefix: `t-${Math.random()}`, points, duration: 60 });
}

function app(overrides: Parameters<typeof registerNodeHttpRoutes>[1] = {}) {
  const exchange = vi.fn(async () => ({
    response: {
      ok: true as const,
      nodeId: "node-1",
      slug: "desk-01",
      credential: `wsmp_node_${"x".repeat(43)}`,
      replaced: null,
      trustLowerPending: false,
      removeAfterOfflineMs: 3_600_000,
    },
    ownerUserId: "owner-1",
    revokedCredentialIds: ["cred-old"],
  }));
  const findOwner = vi.fn(async () => ({ ownerUserId: "owner-1" }));
  const closeRevokedSessions = vi.fn(async () => undefined);
  const hono = new Hono();
  registerNodeHttpRoutes(hono, {
    ipLimiter: limiter(10),
    userLimiter: limiter(20),
    exchange,
    findOwner,
    closeRevokedSessions,
    ...overrides,
  });
  const post = (text: string) =>
    hono.request("/api/node/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: text,
    });
  return { hono, post, exchange, findOwner, closeRevokedSessions };
}

describe("node bootstrap HTTP", () => {
  it("serves the well-known document with the canonical origin and enroll path", async () => {
    const res = await app().hono.request("/.well-known/wsmp");
    expect(await res.json()).toEqual({
      serverVersion: "0.4.0",
      protocolVersion: "3.0",
      origin: "https://proxy.example.com",
      installScript: "/install.sh",
      enrollPath: "/api/node/enroll",
    });
  });

  it("serves an installer that builds the CLI from the configured source", async () => {
    const res = await app().hono.request("/install.sh");
    expect(res.headers.get("content-type")).toContain("shellscript");
    const text = await res.text();
    expect(text).toBe(installScript("https://proxy.example.com"));
    expect(text).toContain(
      `cargo install --git '${CLI_SOURCE.repository}' --branch '${CLI_SOURCE.ref}' --locked --force wsmp`,
    );
    expect(text.startsWith("#!/bin/sh\n")).toBe(true);
    // A deployment pins the exact commit (WMP_CLI_SOURCE_REV) instead of following the branch.
    const pinned = installScript("https://proxy.example.com", "a".repeat(40));
    expect(pinned).toContain(`--rev '${"a".repeat(40)}' --locked`);
    expect(pinned).not.toContain("--branch");
  });

  it("enrolls and closes the sessions of credentials the exchange revoked", async () => {
    const { post, exchange, closeRevokedSessions } = app();
    const res = await post(body());
    expect(res.status).toBe(200);
    // The credential is in this body: never cached.
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({
      ok: true,
      nodeId: "node-1",
      removeAfterOfflineMs: 3_600_000,
    });
    expect(exchange).toHaveBeenCalledWith(
      expect.objectContaining({ code: CODE, slug: "desk-01", replaceConfirmed: false }),
    );
    expect(closeRevokedSessions).toHaveBeenCalledWith(["cred-old"]);
  });

  it("answers a malformed request without naming fields (the code may be in it)", async () => {
    const { post, findOwner } = app();
    for (const text of ["{nope", body({ code: "wsmp_enr_short" }), body({ extra: 1 })]) {
      const res = await post(text);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: "invalid_code" });
    }
    expect(findOwner).not.toHaveBeenCalled();
  });

  it("charges the IP budget before any lookup (successes give it back), then the owner's", async () => {
    const byIp = app({ ipLimiter: limiter(1) });
    // A fleet behind one address: successful enrollments do not use up the IP budget.
    expect((await byIp.post(body())).status).toBe(200);
    expect((await byIp.post(body())).status).toBe(200);
    // A failure keeps its point; the next attempt from that address is refused before lookup.
    expect((await byIp.post("{nope")).status).toBe(400);
    const limited = await byIp.post(body());
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ ok: false, error: "rate_limited" });
    expect(byIp.findOwner).toHaveBeenCalledTimes(2);

    const byOwner = app({ userLimiter: limiter(1) });
    expect((await byOwner.post(body())).status).toBe(200);
    expect((await byOwner.post(body())).status).toBe(429);
    expect(byOwner.exchange).toHaveBeenCalledTimes(1);
  });

  it("passes a refusal through and never exchanges an unusable code", async () => {
    const { post, exchange } = app({
      findOwner: vi.fn(async () => ({
        refusal: { ok: false as const, error: "expired" as const },
      })),
    });
    const res = await post(body());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "expired" });
    expect(exchange).not.toHaveBeenCalled();
  });
});
