import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * `/api/auth/request-password-reset` through the PRODUCTION mount (`createApp`): the app's
 * per-client limiter (3/min, IPv6 by /64), the per-recipient cap, then the uniform handler,
 * which forwards to Better Auth's real HTTP handler so Better Auth's own 3/min per-IP limit
 * applies too. Process dependencies are mocked the app-order.test.ts way; the response floor
 * is set to 0 so the suite does not wait 750 ms per request (the floor has its own tests).
 */

vi.mock("./relay/cli-commands.js", () => ({
  startCliCommand: vi.fn(),
  waitCliCommand: vi.fn(),
  snapshotCliCommand: vi.fn(),
  cancelCommandsForToken: vi.fn(),
  startSupervisedCommand: vi.fn(),
  snapshotSupervisedCommand: vi.fn(),
  listPendingSupervised: vi.fn(() => []),
  submitSupervisedOutput: vi.fn(),
}));
vi.mock("./relay/cli-file-ops.js", () => ({
  runFileOp: vi.fn(),
  cancelFileOpsForToken: vi.fn(),
  sweepExpiredFileOps: vi.fn(),
  auditRefusedFileInput: vi.fn(),
}));

const envMock = vi.hoisted(() => ({
  NODE_ENV: "test",
  WMP_MCP_ENABLED: false,
  BETTER_AUTH_URL: "https://proxy.example.com",
  BETTER_AUTH_SECRET: "reset-mount-test-secret-at-least-thirty-two-chars",
  CORS_ORIGIN: undefined,
  WMP_RATE_LIMIT_SCALE: 1,
  TRUST_PROXY_HOPS: 0,
  MEDIA_MAX_UPLOAD_BYTES: 5 * 1024 * 1024,
  MODEL_API_TRANSCRIPTION_MAX_MULTIPART_BYTES: 1024 * 1024,
  WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: false,
  SSR_CACHE_TTL_SECONDS: 0,
}));
vi.mock("@ws-model-proxy/env/server", () => ({ env: envMock }));

// A generous general auth bucket so only the reset-specific limit is under test.
vi.mock("./rate-limit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./rate-limit.js")>();
  const { RateLimiterMemory } = await import("rate-limiter-flexible");
  return {
    ...actual,
    authLimiter: new RateLimiterMemory({ keyPrefix: "rl:auth", points: 500, duration: 60 }),
  };
});

vi.mock("@ws-model-proxy/auth/password-reset-request", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@ws-model-proxy/auth/password-reset-request")>();
  return {
    ...actual,
    createPasswordResetRequestHandler: (
      auth: Parameters<typeof actual.createPasswordResetRequestHandler>[0],
    ) => actual.createPasswordResetRequestHandler(auth, { floorMs: 0 }),
  };
});

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
vi.mock("@ws-model-proxy/auth", () => ({
  auth: { api: { getSession: vi.fn().mockResolvedValue(null) } },
}));
vi.mock("../../../packages/mailer/src/index", () => ({
  sendEmail: vi.fn(),
  renderInviteUser: vi.fn(() => ({ subject: "", html: "" })),
  verifyTransport: vi.fn(async () => false),
}));

const peer = vi.hoisted(() => ({ address: "10.0.0.1" }));
vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: () => ({ remote: { address: peer.address } }),
}));

import { createApp } from "./app";
import { clientNetworkKey, emailRecipientLimiter, passwordResetRequestLimiter } from "./rate-limit";

const BASE = "https://proxy.example.com";
const sendResetPassword = vi.fn(async () => {});

const memoryAuth = betterAuth({
  baseURL: BASE,
  secret: "reset-mount-test-secret-at-least-thirty-two-chars",
  database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
  emailAndPassword: { enabled: true, sendResetPassword },
  // Better Auth's own limiter is on in production (NODE_ENV=production); on here too.
  rateLimit: { enabled: true },
  logger: { disabled: true },
});

let app: Awaited<ReturnType<typeof createApp>>["app"];
let counter = 0;
let nextIp = 100;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  ({ app } = await createApp({ auth: memoryAuth, passwordResetAuth: memoryAuth }));
});
afterAll(() => vi.restoreAllMocks());

/** A reset request from `address`, each to a fresh recipient (the per-recipient cap is not under test). */
function requestFrom(address: string, email?: string) {
  peer.address = address;
  counter += 1;
  return app.request(`${BASE}/api/auth/request-password-reset`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email: email ?? `person${counter}@example.com` }),
  });
}

describe("password-reset request limit (production mount)", () => {
  it("answers the 4th request in a minute from one IPv4 client with 429 and Retry-After", async () => {
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await requestFrom("198.51.100.7")).status);
    const fourth = await requestFrom("198.51.100.7");

    expect(statuses).toEqual([200, 200, 200]);
    expect(fourth.status).toBe(429);
    expect(Number(fourth.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another client keeps its own budget.
    expect((await requestFrom("198.51.100.8")).status).toBe(200);
  });

  it("makes addresses inside one IPv6 /64 share the budget", async () => {
    const statuses = [];
    for (const address of [
      "2001:db8:aa:1::1",
      "2001:db8:aa:1::2",
      "2001:db8:aa:1:ffff:ffff:ffff:ffff",
      "2001:0db8:00aa:0001::9",
    ]) {
      statuses.push((await requestFrom(address)).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    // A different /64 is a different client.
    expect((await requestFrom("2001:db8:aa:2::1")).status).toBe(200);
  });

  it("treats equivalent spellings of one IPv6 /64 as one client", async () => {
    const statuses = [];
    for (const address of [
      "2001:db8:bb::2:3:192.0.2.1",
      "2001:db8:bb:0:1:2:c000:201",
      "2001:0DB8:00BB:0000::7",
      "2001:db8:bb::9%eth0",
    ]) {
      statuses.push((await requestFrom(address)).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it("keys IPv4-mapped clients by their IPv4 address, not one shared IPv6 bucket", async () => {
    for (let i = 0; i < 3; i++) expect((await requestFrom("::ffff:192.0.2.10")).status).toBe(200);
    expect((await requestFrom("::ffff:c000:20a")).status).toBe(429);
    expect((await requestFrom("::ffff:192.0.2.11")).status).toBe(200);
  });

  it("app limiter refusals carry the app's 429 body and dispatch no work", async () => {
    const context = await memoryAuth.$context;
    const lookup = vi.spyOn(context.internalAdapter, "findUserByEmail");
    for (let i = 0; i < 3; i++) await requestFrom("198.51.100.30");
    const calls = lookup.mock.calls.length;
    const refused = await requestFrom("198.51.100.30");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toHaveProperty("error");
    expect(lookup.mock.calls.length).toBe(calls);
    lookup.mockRestore();
  });

  it("Better Auth's own limiter still answers the 4th request in a minute, with no account work", async () => {
    const ip = "198.51.100.40";
    const context = await memoryAuth.$context;
    const lookup = vi.spyOn(context.internalAdapter, "findUserByEmail");
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      // Clear the app's own bucket so only Better Auth's limiter can refuse.
      await passwordResetRequestLimiter.delete(clientNetworkKey(ip));
      statuses.push((await requestFrom(ip)).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(lookup).toHaveBeenCalledTimes(3);
    lookup.mockRestore();
  });

  it("does not charge the recipient cap for requests the per-client limiter refuses", async () => {
    const target = "recipient-budget@example.com";
    for (let i = 0; i < 3; i++) await requestFrom("198.51.100.50");
    expect((await requestFrom("198.51.100.50", target)).status).toBe(429);

    const statuses = [];
    for (const from of ["198.51.100.60", "198.51.100.61", "198.51.100.62", "198.51.100.63"]) {
      statuses.push((await requestFrom(from, target)).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    await emailRecipientLimiter.delete(target);
  });

  it.each([
    ["an untrusted Origin", { origin: "https://evil.example" }, {}, 403],
    ["a null Origin", { origin: "null" }, {}, 403],
    [
      "an untrusted redirectTo",
      {},
      { redirectTo: "https://evil.example/en-US/reset-password" },
      403,
    ],
    ["a malformed body", {}, { email: 42 }, 400],
  ])(
    "refuses %s before the recipient cap, so it never spends the address's budget",
    async (_label, headers, extra, status) => {
      const target = `refused-${counter}@example.com`;
      // Fresh addresses per case: Better Auth's own limiter counts every valid request per IP.
      const firstIp = nextIp;
      const send = (h: Record<string, string>, body: Record<string, unknown>) => {
        peer.address = `203.0.113.${nextIp++}`;
        return app.request(`${BASE}/api/auth/request-password-reset`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE, ...h },
          body: JSON.stringify({ email: target, ...body }),
        });
      };

      for (let i = 0; i < 3; i++) expect((await send(headers, extra)).status).toBe(status);
      const valid = [];
      for (let i = 0; i < 4; i++) valid.push((await send({}, {})).status);
      // The cap still answers the 4th valid request in the hour.
      expect(valid).toEqual([200, 200, 200, 429]);
      await emailRecipientLimiter.delete(target);
      for (let i = firstIp; i < nextIp; i++) {
        await passwordResetRequestLimiter.delete(`203.0.113.${i}`);
      }
      counter += 1;
    },
  );

  it("lets the request through to the uniform handler (Better Auth's own reply body)", async () => {
    const response = await requestFrom("203.0.113.50");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: true });
  });
});
