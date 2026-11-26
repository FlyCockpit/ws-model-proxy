import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { admin } from "better-auth/plugins";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAdminInviteLocale, runWithAdminInviteLocale } from "./admin-invite-locale";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({ users: [] as Row[], db: {} as Record<string, Row[]> }));
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    NODE_ENV: "test",
    WMP_MCP_ENABLED: false,
    BETTER_AUTH_URL: "https://proxy.example.test",
    BETTER_AUTH_SECRET: "admin-invite-test-secret-at-least-32-characters",
  },
  SIGNUP_ENABLED: true,
}));
vi.mock("./signup-policy", async (original) => ({
  ...(await original<typeof import("./signup-policy")>()),
  getSignupAccessState: async () => ({ signupEnabled: true, userCount: 2 }),
}));
vi.mock("@ws-model-proxy/db", () => {
  // onPasswordReset's transaction, applied to the memory adapter's rows.
  const tx = {
    $queryRaw: vi.fn(async () => [{ acquired: true }]),
    user: {
      updateMany: vi.fn(
        async ({ where, data }: { where: { id: string; email: string }; data: object }) => {
          const row = state.users.find(
            (user) => user.id === where.id && user.email === where.email,
          );
          if (row) Object.assign(row, data);
          return { count: row ? 1 : 0 };
        },
      ),
    },
    verification: {
      findFirst: vi.fn(async ({ where }: { where: { identifier: string } }) => {
        const row = (state.db.verification ?? []).find((r) => r.identifier === where.identifier);
        return row ? { id: row.id } : null;
      }),
      deleteMany: vi.fn(
        async ({
          where,
        }: {
          where: { value?: string; identifier: string | { startsWith: string } };
        }) => {
          const rows = state.db.verification ?? [];
          const matches = (row: Row) =>
            typeof where.identifier === "string"
              ? row.identifier === where.identifier
              : row.value === where.value &&
                String(row.identifier).startsWith(where.identifier.startsWith);
          const keep = rows.filter((row) => !matches(row));
          const count = rows.length - keep.length;
          // The memory adapter may replace the table array: write through the db object.
          state.db.verification = keep;
          return { count };
        },
      ),
    },
  };
  return {
    default: {
      user: { findUnique: vi.fn(async () => null) },
      $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
    },
  };
});
vi.mock("@ws-model-proxy/mailer", () => ({
  isEmailConfigured: () => true,
  sendEmail: vi.fn(),
  renderVerifyEmail: vi.fn(() => ({ subject: "verify", html: "verify" })),
  renderResetPassword: vi.fn(() => ({ subject: "reset", html: "reset" })),
  renderTwoFactorOtp: vi.fn(() => ({ subject: "otp", html: "otp" })),
}));
const proof = vi.hoisted(() => ({ recordProvedEmail: vi.fn(), acceptInvites: vi.fn() }));
vi.mock("./proved-email", async (original) => ({
  ...(await original<typeof import("./proved-email")>()),
  recordProvedEmail: proof.recordProvedEmail,
}));
vi.mock("./share-invite-acceptance", async (original) => ({
  ...(await original<typeof import("./share-invite-acceptance")>()),
  acceptShareInvitesForProvenEmail: proof.acceptInvites,
}));
const { auth: production } = await import("./index");

function setup() {
  const db: Record<string, Row[]> = { user: [], account: [], session: [], verification: [] };
  state.users = db.user!;
  state.db = db;
  const verificationMail = vi.fn(async () => {});
  const auth = betterAuth({
    database: memoryAdapter(db),
    baseURL: "https://proxy.example.test",
    secret: "admin-invite-test-secret-at-least-32-characters",
    user: production.options.user,
    emailAndPassword: production.options.emailAndPassword,
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      sendVerificationEmail: verificationMail,
    },
    databaseHooks: { user: { create: production.options.databaseHooks?.user?.create } },
    plugins: [admin()],
    rateLimit: { enabled: false },
  });
  return { db, auth, verificationMail };
}

describe("admin invite on real Better Auth with production creation/reset hooks", {
  timeout: 30_000,
}, () => {
  beforeEach(() => vi.clearAllMocks());

  it("stores the invite locale on insertion, sends no verification mail, and verifies only when the one-time link is spent", async () => {
    const { db, auth, verificationMail } = setup();
    const created = await runWithAdminInviteLocale("es-MX", () =>
      auth.api.createUser({
        body: {
          name: "Invitee",
          email: "invitee@example.test",
          password: "discarded-random-password",
          role: "user",
        },
      }),
    );
    expect(db.user).toHaveLength(1);
    expect(db.user?.[0]).toMatchObject({ locale: "es-MX", emailVerified: false });
    expect(verificationMail).not.toHaveBeenCalled();
    expect(getAdminInviteLocale()).toBeUndefined();
    // Same rows createSetPasswordLink writes (API tests pin its writer): the link and the
    // permanent admin-invited mark.
    const context = await auth.$context;
    await context.internalAdapter.createVerificationValue({
      identifier: "reset-password:one-time-invite",
      value: created.user.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await context.internalAdapter.createVerificationValue({
      identifier: `admin-invited:${created.user.id}`,
      value: created.user.id,
      expiresAt: new Date("9999-12-31T00:00:00.000Z"),
    });
    // A resend that raced the setup minted a second link before the reset finished.
    await context.internalAdapter.createVerificationValue({
      identifier: "reset-password:raced-resend",
      value: created.user.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await auth.api.resetPassword({
      body: { token: "one-time-invite", newPassword: "chosen-password-1" },
    });
    expect(db.user?.[0]).toMatchObject({ emailVerified: true });
    // Finishing the setup deleted it: no working link to the activated account is left.
    await expect(
      auth.api.resetPassword({ body: { token: "raced-resend", newPassword: "attacker-pass-1" } }),
    ).rejects.toMatchObject({ body: { code: "INVALID_TOKEN" } });
    // The admin may have held the link: no WMP mailbox proof, no share acceptance, and the mark
    // stays (a later reset still proves nothing).
    expect(proof.recordProvedEmail).not.toHaveBeenCalled();
    expect(proof.acceptInvites).not.toHaveBeenCalled();
    expect(
      db.verification?.some((row) => row.identifier === `admin-invited:${created.user.id}`),
    ).toBe(true);
    await expect(
      auth.api.resetPassword({
        body: { token: "one-time-invite", newPassword: "another-password" },
      }),
    ).rejects.toMatchObject({ body: { code: "INVALID_TOKEN" } });
    await expect(
      auth.api.signInEmail({
        body: { email: "invitee@example.test", password: "chosen-password-1" },
      }),
    ).resolves.toBeTruthy();
    expect(verificationMail).not.toHaveBeenCalled();
  });

  it("leaves a public sign-up's reset unverified, so verify-email still verifies and proves it", async () => {
    const { db, auth } = setup();
    const created = await auth.api.signUpEmail({
      body: { name: "Signup", email: "signup@example.test", password: "chosen-password-1" },
    });
    const context = await auth.$context;
    await context.internalAdapter.createVerificationValue({
      identifier: "reset-password:forgot",
      value: created.user.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await auth.api.resetPassword({ body: { token: "forgot", newPassword: "chosen-password-2" } });
    expect(db.user?.[0]).toMatchObject({ emailVerified: false });
    expect(proof.recordProvedEmail).not.toHaveBeenCalled();
  });

  it("keeps public signup's verification mail and header-selected locale", async () => {
    const { db, auth, verificationMail } = setup();
    await auth.api.signUpEmail({
      body: { name: "Signup", email: "signup@example.test", password: "chosen-password-1" },
      headers: new Headers({ "x-app-locale": "es-MX" }),
    });
    expect(db.user?.[0]).toMatchObject({ locale: "es-MX", emailVerified: false });
    expect(verificationMail).toHaveBeenCalledTimes(1);
  });
});
