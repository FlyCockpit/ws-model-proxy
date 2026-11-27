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
const currentUser = vi.hoisted(() => vi.fn());
vi.mock("@ws-model-proxy/db", () => ({
  default: new Proxy(makePrismaStub() as object, {
    get(target, key, receiver) {
      if (key === "user") return { findUnique: currentUser };
      return Reflect.get(target, key, receiver);
    },
  }),
}));

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
    currentUser.mockReset();
  });

  it("uses the password pepper for Better Auth hashing and verification", async () => {
    const auth = await loadAuth(false);
    const { passwordPepper } = await import("./index");
    expect(auth.options.emailAndPassword?.password).toEqual({
      hash: passwordPepper.hash,
      verify: passwordPepper.verify,
    });
  });

  it("without SMTP there is no reset mail and the request route refuses", async () => {
    const auth = await loadAuth(false);
    const options = auth.options.emailAndPassword;
    expect(options?.sendResetPassword).toBeUndefined();
    expect(options?.revokeSessionsOnPasswordReset).toBe(true);
    expect(auth.options.session).not.toHaveProperty("cookieCache.enabled", true);
    expect(auth.options).not.toHaveProperty("secondaryStorage");

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
  it("without SMTP never accepts reset shares even if old durable proof exists", async () => {
    const auth = await loadAuth(false);
    const { preparePasswordResetFinalization } = await import("./password-reset");
    const { registerShareInviteAcceptor } = await import("./share-invite-acceptance");
    const accept = vi.fn(async () => 1);
    registerShareInviteAcceptor(accept);
    currentUser.mockResolvedValue({
      id: "u",
      email: "u@example.test",
      emailVerified: true,
      provedEmail: "u@example.test",
    });
    const context: { options: import("better-auth").BetterAuthOptions } = {
      options: { emailAndPassword: { enabled: true, onPasswordReset: async () => {} } },
    };
    preparePasswordResetFinalization(context);
    await context.options.emailAndPassword!.onPasswordReset!(
      {
        user: {
          id: "u",
          email: "u@example.test",
          name: "U",
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      undefined,
    );
    await auth.options.hooks!.after!({ path: "/reset-password", context } as never);
    expect(accept).not.toHaveBeenCalled();
    expect(currentUser).not.toHaveBeenCalled();
  });
  it.each(["missing-callback", "id", "email", "verified", "proof", "missing-user"] as const)(
    "committed reset evidence cannot accept shares with %s",
    async (mismatch) => {
      const auth = await loadAuth(true);
      const { preparePasswordResetFinalization } = await import("./password-reset");
      const { registerShareInviteAcceptor } = await import("./share-invite-acceptance");
      const accept = vi.fn(async () => 1);
      registerShareInviteAcceptor(accept);
      currentUser.mockResolvedValue(
        mismatch === "missing-user"
          ? null
          : {
              id: mismatch === "id" ? "other" : "u",
              email: mismatch === "email" ? "changed@example.test" : "u@example.test",
              emailVerified: mismatch !== "verified",
              provedEmail: mismatch === "proof" ? null : "u@example.test",
            },
      );
      const context: { options: import("better-auth").BetterAuthOptions } = {
        options: { emailAndPassword: { enabled: true, onPasswordReset: async () => {} } },
      };
      preparePasswordResetFinalization(context);
      if (mismatch !== "missing-callback")
        await context.options.emailAndPassword!.onPasswordReset!(
          {
            user: {
              id: "u",
              email: "u@example.test",
              name: "U",
              emailVerified: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
          undefined,
        );
      await auth.options.hooks!.after!({ path: "/reset-password", context } as never);
      expect(accept).not.toHaveBeenCalled();
      if (mismatch === "missing-callback") expect(currentUser).not.toHaveBeenCalled();
    },
  );
});
