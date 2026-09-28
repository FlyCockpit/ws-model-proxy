import { describe, expect, it, vi } from "vitest";

/**
 * The PRODUCTION auth instance (./index.ts) keeps Better Auth's own device
 * verification, approve, deny and token routes disabled, so the only way to
 * claim a `wsmp login` code is `cliCredentials.approveDeviceLogin`. The other
 * device tests build their own instance; this one pins index.ts's
 * `disabledPaths` wiring. Mocks as in auth-startup-schema.test.ts.
 */

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    NODE_ENV: "test",
    // Flag ON: the deploy-time superset — the schema must satisfy the FULL
    // MCP surface (jwt/mcp/cimd tables), never only the dormant subset.
    WMP_MCP_ENABLED: true,
    BETTER_AUTH_URL: "https://proxy.example.com",
    BETTER_AUTH_SECRET: "startup-schema-test-secret-at-least-32-chars",
    CORS_ORIGIN: undefined,
    SMTP_HOST: undefined,
  },
}));

// Prisma seam: a permissive callable-proxy stub. The 1.7.3 prisma adapter
// validates client SHAPE asynchronously at construction (the deferred
// startup check — a bare {} makes it reject with "Model ... does not
// exist"); the stub answers every delegate/method probe with a settled
// promise so construction completes. This test never triggers real adapter
// OPERATIONS, and the LIVE check against actual PostgreSQL stays the
// Part K2 deferral.
const makePrismaStub = (): unknown =>
  new Proxy(() => Promise.resolve(undefined), {
    get(target, prop, receiver) {
      if (typeof prop === "symbol" || prop === "then") return Reflect.get(target, prop, receiver);
      return makePrismaStub();
    },
  });
vi.mock("@ws-model-proxy/db", () => ({ default: makePrismaStub() }));

vi.mock("@ws-model-proxy/mailer", () => ({
  isEmailConfigured: () => false,
  sendEmail: vi.fn(),
  renderVerifyEmail: vi.fn(() => ({ subject: "", html: "" })),
  renderTwoFactorOtp: vi.fn(() => ({ subject: "", html: "" })),
  verifyTransport: vi.fn(async () => false),
}));

// The REAL production instance (module-scope construction over the mocked
// Prisma seam — no connection is made; the 1.7.3 adapter schema check is
// deferred to first use, which these tests never trigger).
const { auth } = await import("./index");

const BASE = "https://proxy.example.com/api/auth";

function post(path: string) {
  return auth.handler(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://proxy.example.com" },
      body: JSON.stringify({ userCode: "ABCD-EFGH" }),
    }),
  );
}

describe("production auth device routes", () => {
  it.each(["/device/approve", "/device/deny", "/device/token"])("POST %s is 404", async (path) => {
    expect((await post(path)).status).toBe(404);
  });

  it.each(["/device", "/device/"])("GET %s is 404", async (path) => {
    const response = await auth.handler(
      new Request(`${BASE}${path}?user_code=ABCD-EFGH`, { method: "GET" }),
    );
    expect(response.status).toBe(404);
  });

  it("still serves /device/code, which the CLI starts from", async () => {
    expect((await post("/device/code")).status).not.toBe(404);
  });
});
