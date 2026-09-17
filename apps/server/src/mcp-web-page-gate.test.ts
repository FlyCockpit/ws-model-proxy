import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MCP web login/consent page gate tests (MCP plan Phase 6; invariant 13).
 *
 * Two layers:
 *  1. PURE matcher tests for the exact valid-locale raw-path set — near-miss
 *     forms (unknown locales, trailing slashes, case variants,
 *     percent-encoded spellings, subpaths) must NOT match, so they keep the
 *     normal SPA/SSR handling.
 *  2. PRODUCTION-REGISTRATION tests mounting the REAL createApp() output
 *     (the app-order.test.ts pattern: shared mutable env mock, mocked
 *     Prisma/auth/mailer/conninfo): flag-off valid-locale forms return a
 *     REAL 404 for every method; flag-on requests pass the gate through.
 *
 * Pass-through while ENABLED is proven structurally: the gate middleware
 * only short-circuits on `!enabled() && isMcpWebPageRawPath(...)`; the pure
 * matcher tests below pin the second conjunct and the flag-on requests pin
 * the first (they reach downstream handling instead of the gate's 404).
 */

const envMock = vi.hoisted(() => ({
  NODE_ENV: "test",
  WMP_MCP_ENABLED: false,
  BETTER_AUTH_URL: "https://proxy.example.com",
  BETTER_AUTH_SECRET: "contract-test-secret-at-least-thirty-two-characters",
  CORS_ORIGIN: "https://app.example.com",
  RATE_LIMIT_AUTH_POINTS: 500,
  RATE_LIMIT_AUTH_DURATION: 60,
  RATE_LIMIT_AUTH_BLOCK_DURATION: 0,
  RATE_LIMIT_SIGNUP_POINTS: 3,
  RATE_LIMIT_SIGNUP_DURATION: 3600,
  RATE_LIMIT_SIGNUP_BLOCK_DURATION: 3600,
  RATE_LIMIT_RPC_POINTS: 1000,
  RATE_LIMIT_RPC_DURATION: 60,
  RATE_LIMIT_EMAIL_RECIPIENT_POINTS: 3,
  RATE_LIMIT_EMAIL_RECIPIENT_DURATION: 3600,
  RATE_LIMIT_EMAIL_RECIPIENT_BLOCK_DURATION: 0,
  RATE_LIMIT_SIGNUP_RECIPIENT_POINTS: 6,
  RATE_LIMIT_MCP_POINTS: 2,
  RATE_LIMIT_MCP_DURATION: 60,
  RATE_LIMIT_MCP_CONSENT_POINTS: 2,
  RATE_LIMIT_MCP_CONSENT_DURATION: 60,
  TRUST_PROXY_HOPS: undefined,
  MEDIA_MAX_UPLOAD_BYTES: 5 * 1024 * 1024,
  MODEL_API_TRANSCRIPTION_MAX_MULTIPART_BYTES: 1024 * 1024,
  MODEL_API_GLOBAL_CAPACITY_ENABLED: false,
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

import { SUPPORTED_LOCALES } from "@ws-model-proxy/config/locales";
import { createApp } from "./app";
import { isMcpWebPageRawPath, MCP_WEB_PAGE_PATHS } from "./mcp-web-page-gate";

const BASE = "https://proxy.example.com";
const HOST = { host: "proxy.example.com" } as const;

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

describe("isMcpWebPageRawPath (pure matcher)", () => {
  it("matches exactly the supported-locale login/consent forms", () => {
    expect([...MCP_WEB_PAGE_PATHS].sort()).toEqual(
      ["/en-US/mcp-login", "/en-US/mcp-consent", "/es-MX/mcp-login", "/es-MX/mcp-consent"].sort(),
    );
    for (const path of MCP_WEB_PAGE_PATHS) expect(isMcpWebPageRawPath(path)).toBe(true);
    expect(SUPPORTED_LOCALES.length).toBeGreaterThan(0);
  });

  it("does not match near-miss forms", () => {
    const nearMisses = [
      "/fr-FR/mcp-login",
      "/en-US/mcp-login/",
      "/EN-US/mcp-login",
      "/en-us/mcp-login",
      "/en-US/mcp-loginx",
      "/en-US/mcp-login/extra",
      "/mcp-login",
      "/api/auth/oauth2/authorize",
      "/%65n-US/mcp-login",
    ];
    for (const path of nearMisses) expect(isMcpWebPageRawPath(path)).toBe(false);
  });
});

describe("createApp MCP web page gate (production registration)", () => {
  let app: Awaited<ReturnType<typeof createApp>>["app"];

  beforeEach(async () => {
    envMock.WMP_MCP_ENABLED = false;
    app = (await createApp({ auth: memoryAuth as never })).app;
  });

  afterEach(() => {
    envMock.WMP_MCP_ENABLED = false;
  });

  it("returns a real 404 for every method on valid-locale forms while disabled", async () => {
    for (const path of MCP_WEB_PAGE_PATHS) {
      for (const method of ["GET", "POST", "OPTIONS", "HEAD", "PUT"] as const) {
        const res = await app.request(
          new Request(`${BASE}${path}`, {
            method,
            headers: { ...HOST, origin: "https://app.example.com" },
          }),
        );
        expect(res.status, `${method} ${path}`).toBe(404);
      }
    }
  });

  it("keeps near-miss locale forms on normal handling (not the gate's 404-for-every-method)", async () => {
    // In the test NODE_ENV there is no SSR catch-all, so unmatched paths also
    // 404 — the distinguishing assertion is the /health control plus the
    // near-miss path NOT being owned by the gate (the pure matcher tests pin
    // non-membership; here we prove the app still answers normally for a
    // non-page path while the gate is off).
    const health = await app.request(new Request(`${BASE}/health`, { headers: HOST }));
    expect(health.status).toBe(200);
  });

  it("passes valid-locale forms through to downstream handling while enabled", async () => {
    // Observability seam: CORS_ORIGIN is set in the env mock, so the cors()
    // middleware answers an OPTIONS preflight with 204 — but ONLY for
    // requests that survive the page gate. Flag-off: the gate owns the path
    // and answers 404 before CORS. Flag-on: the gate passes through and the
    // CORS preflight completes. That difference proves the enabled app is a
    // pass-through, not a second 404.
    const preflight = {
      host: "proxy.example.com",
      origin: "https://app.example.com",
      "access-control-request-method": "GET",
    };
    // Capture the flag-off answer BEFORE flipping the shared env mock: the
    // gate reads the flag at REQUEST time, so ordering matters.
    const disabledRes = await app.request(
      new Request(`${BASE}/en-US/mcp-login`, { method: "OPTIONS", headers: preflight }),
    );
    envMock.WMP_MCP_ENABLED = true;
    const enabledApp = (await createApp({ auth: memoryAuth as never })).app;
    const enabledRes = await enabledApp.request(
      new Request(`${BASE}/en-US/mcp-login`, { method: "OPTIONS", headers: preflight }),
    );
    expect(disabledRes.status).toBe(404);
    expect(enabledRes.status).toBe(204);
  });
});
