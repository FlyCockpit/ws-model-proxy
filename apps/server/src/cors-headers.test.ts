import { APP_LOCALE_HEADER } from "@ws-model-proxy/config/locales";
import { SHARE_INVITE_HEADER } from "@ws-model-proxy/config/share-invite";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it, vi } from "vitest";

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

/**
 * Preflights through the REAL createApp() output (the app-order.test.ts
 * pattern) with CORS_ORIGIN set, so a change to the allowHeaders wiring in
 * app.ts is observable here. A hand-built cors() would mirror the wiring and
 * survive that regression.
 */

const envMock = vi.hoisted(() => ({
  NODE_ENV: "test",
  WMP_MCP_ENABLED: false,
  BETTER_AUTH_URL: "https://proxy.example.com",
  BETTER_AUTH_SECRET: "contract-test-secret-at-least-thirty-two-characters",
  CORS_ORIGIN: "https://app.example.com",
  WMP_RATE_LIMIT_SCALE: 1,
  TRUST_PROXY_HOPS: undefined,
  MEDIA_MAX_UPLOAD_BYTES: 5 * 1024 * 1024,
  MODEL_API_TRANSCRIPTION_MAX_MULTIPART_BYTES: 1024 * 1024,
  WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: false,
  SSR_CACHE_TTL_SECONDS: 0,
}));
vi.mock("@ws-model-proxy/env/server", () => ({ env: envMock }));

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

const mockGetConnInfo = vi.hoisted(() => vi.fn(() => ({ remote: { address: "10.0.0.1" } })));
vi.mock("@hono/node-server/conninfo", () => ({ getConnInfo: mockGetConnInfo }));

import { createApp } from "./app";
import { CORS_ALLOW_HEADERS } from "./cors-headers";

const BASE = "https://proxy.example.com";
const APP_ORIGIN = "https://app.example.com";

const memoryAuth = betterAuth({
  baseURL: BASE,
  secret: "contract-test-secret-at-least-thirty-two-characters",
  database: memoryAdapter({
    oauthAccessToken: [],
    oauthRefreshToken: [],
    oauthConsent: [],
    oauthClient: [],
    oauthResource: [],
    oauthClientResource: [],
    oauthClientAssertion: [],
    jwks: [],
    verification: [],
    session: [],
    user: [],
    account: [],
    deviceCode: [],
  }),
  plugins: [],
});

async function preflight(requestHeaders: string) {
  const { app } = await createApp({ auth: memoryAuth as never });
  return app.request(
    new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "OPTIONS",
      headers: {
        host: "proxy.example.com",
        Origin: APP_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": requestHeaders,
      },
    }),
  );
}

function allowedHeaders(res: Response): string[] {
  return (res.headers.get("access-control-allow-headers") ?? "")
    .toLowerCase()
    .split(",")
    .map((h) => h.trim());
}

describe("createApp CORS preflight (CORS_ALLOW_HEADERS wiring)", () => {
  it("echoes every CORS_ALLOW_HEADERS entry back on the preflight", async () => {
    const res = await preflight([...CORS_ALLOW_HEADERS].join(","));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    const allowed = allowedHeaders(res);
    for (const header of CORS_ALLOW_HEADERS) expect(allowed).toContain(header.toLowerCase());
  });

  it("does not echo a header outside CORS_ALLOW_HEADERS (allowlist stays explicit)", async () => {
    const res = await preflight("content-type,x-not-allowlisted");
    const allowed = allowedHeaders(res);
    expect(allowed).toContain("content-type");
    expect(allowed).not.toContain("x-not-allowlisted");
    expect(allowed.slice().sort()).toEqual(CORS_ALLOW_HEADERS.map((h) => h.toLowerCase()).sort());
  });

  it("allows the locale header the auth client sets on every request", async () => {
    expect(CORS_ALLOW_HEADERS).toContain(APP_LOCALE_HEADER);
    const res = await preflight(`content-type,${APP_LOCALE_HEADER}`);
    expect(allowedHeaders(res)).toContain(APP_LOCALE_HEADER);
  });

  it("allows the invite header the sign-up page sets on an invite sign-up", async () => {
    expect(CORS_ALLOW_HEADERS).toContain(SHARE_INVITE_HEADER);
    const res = await preflight(`content-type,${SHARE_INVITE_HEADER}`);
    expect(allowedHeaders(res)).toContain(SHARE_INVITE_HEADER);
  });

  it("allows the CSRF header Better-Auth's client plugin sets", async () => {
    const res = await preflight("x-csrf-token");
    expect(allowedHeaders(res)).toContain("x-csrf-token");
  });
});
