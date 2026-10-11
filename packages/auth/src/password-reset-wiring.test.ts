import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    NODE_ENV: "test",
    WMP_MCP_ENABLED: false,
    BETTER_AUTH_URL: "https://proxy.example.com",
    BETTER_AUTH_SECRET: "password-reset-wiring-test-secret-32-chars",
    CORS_ORIGIN: undefined,
    SMTP_HOST: undefined,
  },
  SIGNUP_ENABLED: false,
}));

// Callable-proxy Prisma stub (see share-invite-signup-hooks.test.ts): the auth
// instance constructs without a database.
function makePrismaStub(): unknown {
  return new Proxy(() => Promise.resolve(undefined), {
    get(target, prop, receiver) {
      if (typeof prop === "symbol" || prop === "then") return Reflect.get(target, prop, receiver);
      return makePrismaStub();
    },
  });
}
vi.mock("@ws-model-proxy/db", () => ({ default: makePrismaStub() }));

const emailConfigured = vi.hoisted(() => ({ value: false }));
vi.mock("@ws-model-proxy/mailer", () => ({
  isEmailConfigured: () => emailConfigured.value,
  sendEmail: vi.fn(),
  renderVerifyEmail: vi.fn(() => ({ subject: "", html: "" })),
  renderResetPassword: vi.fn(() => ({ subject: "", html: "" })),
  renderTwoFactorOtp: vi.fn(() => ({ subject: "", html: "" })),
  verifyTransport: vi.fn(async () => false),
}));

async function loadAuth(smtp: boolean) {
  emailConfigured.value = smtp;
  vi.resetModules();
  return (await import("./index")).auth;
}

describe("password reset wiring", { timeout: 60_000 }, () => {
  beforeEach(() => {
    emailConfigured.value = false;
  });

  it("without SMTP there is no reset mail and the request route refuses", async () => {
    const auth = await loadAuth(false);
    const options = auth.options.emailAndPassword;
    expect(options?.sendResetPassword).toBeUndefined();
    expect(options?.revokeSessionsOnPasswordReset).toBe(true);

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await auth.handler(
      new Request("https://proxy.example.com/api/auth/request-password-reset", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://proxy.example.com" },
        body: JSON.stringify({ email: "person@example.com" }),
      }),
    );
    error.mockRestore();
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "RESET_PASSWORD_DISABLED" });
  });

  it("with SMTP the reset mail is wired with a one-hour token and session revocation", async () => {
    const auth = await loadAuth(true);
    const options = auth.options.emailAndPassword;
    expect(typeof options?.sendResetPassword).toBe("function");
    expect(options?.revokeSessionsOnPasswordReset).toBe(true);
    expect(options?.resetPasswordTokenExpiresIn).toBe(3600);
    expect(options?.minPasswordLength).toBe(8);
  });
});
