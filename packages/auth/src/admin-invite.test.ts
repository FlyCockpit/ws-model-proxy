import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { admin } from "better-auth/plugins";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAdminInviteLocale, runWithAdminInviteLocale } from "./admin-invite-locale";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({ db: {} as Record<string, Row[]> }));
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
  // The Prisma calls the production hooks make, run against the memory adapter's own tables
  // (always read through `state.db`: the memory adapter may replace a table array).
  type Where = Record<string, unknown>;
  const table = (name: string) => {
    state.db[name] ??= [];
    return state.db[name] as Row[];
  };
  const time = (value: unknown) => new Date(value as string | number | Date).getTime();
  const matches = (row: Row, where: Where = {}) =>
    Object.entries(where).every(([key, wanted]) => {
      if (wanted && typeof wanted === "object" && !(wanted instanceof Date)) {
        const condition = wanted as Record<string, unknown>;
        if ("startsWith" in condition)
          return String(row[key]).startsWith(String(condition.startsWith));
        if ("gt" in condition) return time(row[key]) > time(condition.gt);
        if ("in" in condition) return (condition.in as unknown[]).includes(row[key]);
        return false;
      }
      return row[key] === wanted;
    });
  const project = (row: Row, select: Record<string, unknown> | undefined) => {
    if (!select) return { ...row };
    const out: Row = {};
    for (const [key, spec] of Object.entries(select)) {
      if (key === "accounts" || key === "sessions") {
        const relation = spec as { where?: Where; select: Record<string, unknown>; take?: number };
        out[key] = table(key === "accounts" ? "account" : "session")
          .filter((child) => child.userId === row.id && matches(child, relation.where))
          .slice(0, relation.take)
          .map((child) => project(child, relation.select));
      } else out[key] = row[key] ?? null;
    }
    return out;
  };
  const model = (name: string) => ({
    findUnique: vi.fn(async ({ where, select }: { where: Where; select?: Row }) => {
      const row = table(name).find((candidate) => matches(candidate, where));
      return row ? project(row, select) : null;
    }),
    findFirst: vi.fn(async ({ where, select }: { where: Where; select?: Row }) => {
      const row = table(name).find((candidate) => matches(candidate, where));
      return row ? project(row, select) : null;
    }),
    findMany: vi.fn(async ({ where, select }: { where: Where; select?: Row }) =>
      table(name)
        .filter((row) => matches(row, where))
        .map((row) => project(row, select)),
    ),
    create: vi.fn(async ({ data, select }: { data: Row; select?: Row }) => {
      const row = {
        id: `${name}-${Math.random().toString(36).slice(2)}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      table(name).push(row);
      return project(row, select);
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Where; data: Row }) => {
      const rows = table(name).filter((row) => matches(row, where));
      for (const row of rows) Object.assign(row, data);
      return { count: rows.length };
    }),
    deleteMany: vi.fn(async ({ where }: { where: Where }) => {
      const rows = table(name);
      const keep = rows.filter((row) => !matches(row, where));
      state.db[name] = keep;
      return { count: rows.length - keep.length };
    }),
  });
  const client = {
    // The owner fence (credential-setup-lock.ts): always granted here.
    $queryRaw: vi.fn(async () => [{ acquired: true }]),
    user: model("user"),
    verification: model("verification"),
    $transaction: vi.fn(),
  };
  client.$transaction.mockImplementation(async (operation: (tx: typeof client) => unknown) =>
    operation(client),
  );
  return { default: client };
});
const mail = vi.hoisted(() => ({ sendEmail: vi.fn(async (_mail: unknown) => {}) }));
vi.mock("@ws-model-proxy/mailer", () => ({
  isEmailConfigured: () => true,
  sendEmail: mail.sendEmail,
  renderVerifyEmail: vi.fn(() => ({ subject: "verify", html: "verify" })),
  renderResetPassword: vi.fn(({ url }: { url: string }) => ({ subject: "reset", html: url })),
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
const { recordResetLinkMailed } = await import("./password-reset-links");

const INVITED_MARK_EXPIRES = new Date("9999-12-31T00:00:00.000Z");

function setup() {
  const db: Record<string, Row[]> = { user: [], account: [], session: [], verification: [] };
  state.db = db;
  const verificationMail = vi.fn(async (_data: { token: string }) => {});
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
    hooks: production.options.hooks,
    databaseHooks: {
      user: {
        create: production.options.databaseHooks?.user?.create,
        update: production.options.databaseHooks?.user?.update,
      },
    },
    plugins: [admin()],
    rateLimit: { enabled: false },
  });
  const verifications = () => state.db.verification ?? [];
  const user = (email: string) => {
    const row = (state.db.user ?? []).find((candidate) => candidate.email === email);
    if (!row) throw new Error(`no user ${email}`);
    return row;
  };
  /** A set-password link row, exactly as packages/api createSetPasswordLink writes it. */
  const link = async (userId: string, token: string) => {
    const context = await auth.$context;
    await context.internalAdapter.createVerificationValue({
      identifier: `reset-password:${token}`,
      value: userId,
      expiresAt: new Date(Date.now() + 60_000),
    });
  };
  /** users.invite: the account under the invite scope, then the permanent admin-invited mark. */
  const invite = async (email: string) => {
    const created = await runWithAdminInviteLocale("es-MX", () =>
      auth.api.createUser({
        body: { name: "Invitee", email, password: "discarded-random-password", role: "user" },
      }),
    );
    const context = await auth.$context;
    await context.internalAdapter.createVerificationValue({
      identifier: `admin-invited:${created.user.id}`,
      value: created.user.id,
      expiresAt: INVITED_MARK_EXPIRES,
    });
    return created.user.id;
  };
  const reset = (token: string, newPassword: string) =>
    auth.api.resetPassword({ body: { token, newPassword } });
  const signIn = (email: string, password: string) =>
    auth.api.signInEmail({ body: { email, password } });
  /** Forgot-password through Better Auth; resolves the token once it is recorded as mailed. */
  const forgot = async (email: string) => {
    const before = new Set(verifications().map((row) => row.identifier));
    await auth.api.requestPasswordReset({ body: { email } });
    let token = "";
    await vi.waitFor(() => {
      const row = verifications().find(
        (candidate) =>
          String(candidate.identifier).startsWith("reset-password:") &&
          !before.has(candidate.identifier),
      );
      expect(row).toBeTruthy();
      token = String(row?.identifier).slice("reset-password:".length);
      expect(mail.sendEmail).toHaveBeenCalled();
    });
    return token;
  };
  return { db, auth, verificationMail, verifications, user, link, invite, reset, signIn, forgot };
}

const isMailedRow = (row: Row) => String(row.identifier).startsWith("reset-password-mailed:");
const isResetRow = (row: Row) => String(row.identifier).startsWith("reset-password:");

describe("admin invite on real Better Auth with production hooks", { timeout: 30_000 }, () => {
  beforeEach(() => vi.clearAllMocks());

  it("a mailed invite link verifies and proves the address, accepts its share invites, and kills a raced resend link", async () => {
    const t = setup();
    const userId = await t.invite("invitee@example.test");
    expect(t.user("invitee@example.test")).toMatchObject({
      locale: "es-MX",
      emailVerified: false,
    });
    expect(t.verificationMail).not.toHaveBeenCalled();
    expect(getAdminInviteLocale()).toBeUndefined();
    await t.link(userId, "one-time-invite");
    // users.invite records the link as mailed once the mail was accepted.
    expect(
      await recordResetLinkMailed({
        token: "one-time-invite",
        userId,
        email: "invitee@example.test",
      }),
    ).toBe(true);
    // The mailed record never stores the token itself.
    expect(t.verifications().filter(isMailedRow)).toHaveLength(1);
    expect(JSON.stringify(t.verifications().filter(isMailedRow))).not.toContain("one-time-invite");
    // A resend that raced the setup minted a second link before the reset finished.
    await t.link(userId, "raced-resend");

    await t.reset("one-time-invite", "chosen-password-1");
    expect(t.user("invitee@example.test")).toMatchObject({
      emailVerified: true,
      provedEmail: "invitee@example.test",
    });
    expect(proof.acceptInvites).toHaveBeenCalledWith({
      id: userId,
      email: "invitee@example.test",
      emailVerified: true,
    });
    expect(t.verifications().filter(isMailedRow)).toHaveLength(0);
    // Finishing the setup deleted it: no working link to the activated account is left.
    await expect(t.reset("raced-resend", "attacker-pass-1")).rejects.toMatchObject({
      body: { code: "INVALID_TOKEN" },
    });
    // The mark stays for good.
    expect(t.verifications().some((row) => row.identifier === `admin-invited:${userId}`)).toBe(
      true,
    );
    await expect(t.signIn("invitee@example.test", "chosen-password-1")).resolves.toBeTruthy();
    expect(t.verificationMail).not.toHaveBeenCalled();
  });

  it("a link shown to the admin sets the password and verifies nothing; verify-email at sign-in does, and kills the leftover links", async () => {
    const t = setup();
    const userId = await t.invite("shown@example.test");
    await t.link(userId, "shown-1");
    await t.reset("shown-1", "chosen-password-1");
    expect(t.user("shown@example.test")).toMatchObject({ emailVerified: false });
    expect(t.user("shown@example.test").provedEmail ?? null).toBeNull();
    expect(proof.acceptInvites).not.toHaveBeenCalled();
    // Still a pending invite: the admin's resend (SMTP still failing) shows another link.
    await t.link(userId, "shown-2");

    // Sign-in is refused until the address is confirmed, and mails the verification link.
    await expect(t.signIn("shown@example.test", "chosen-password-1")).rejects.toMatchObject({
      body: { code: "EMAIL_NOT_VERIFIED" },
    });
    expect(t.verificationMail).toHaveBeenCalledTimes(1);
    const { token } = t.verificationMail.mock.calls[0]?.[0] ?? { token: "" };
    const response = await t.auth.handler(
      new Request(
        `https://proxy.example.test/api/auth/verify-email?token=${encodeURIComponent(token)}`,
      ),
    );
    expect(response.status).toBe(200);
    expect(t.user("shown@example.test")).toMatchObject({ emailVerified: true });
    expect(proof.recordProvedEmail).toHaveBeenCalledTimes(1);
    // The activation deleted the leftover shown link.
    expect(t.verifications().filter(isResetRow)).toHaveLength(0);
    await expect(t.reset("shown-2", "attacker-pass-1")).rejects.toMatchObject({
      body: { code: "INVALID_TOKEN" },
    });
    await expect(t.signIn("shown@example.test", "chosen-password-1")).resolves.toBeTruthy();
  });

  it("refuses a shown link once the account is active even if the cleanup missed it, and a mailed reset still works", async () => {
    const t = setup();
    const userId = await t.invite("active@example.test");
    await t.link(userId, "first");
    await recordResetLinkMailed({ token: "first", userId, email: "active@example.test" });
    await t.reset("first", "chosen-password-1");
    expect(t.user("active@example.test")).toMatchObject({ emailVerified: true });
    // A shown link the activation's tidy-up never deleted (as if it had failed).
    await t.link(userId, "leftover");
    await expect(t.reset("leftover", "attacker-pass-1")).rejects.toMatchObject({
      body: { code: "INVALID_TOKEN" },
    });
    expect(t.verifications().filter(isResetRow)).toHaveLength(0);
    await expect(t.signIn("active@example.test", "chosen-password-1")).resolves.toBeTruthy();

    // Forgot-password mails a link and records it before the send: it works for the active
    // account.
    const token = await t.forgot("active@example.test");
    expect(t.verifications().filter(isMailedRow)).toHaveLength(1);
    await t.reset(token, "chosen-password-2");
    await expect(t.signIn("active@example.test", "chosen-password-2")).resolves.toBeTruthy();
  });

  it("a public sign-up's mailed forgot-password reset verifies and proves it; an unmailed link is refused", async () => {
    const t = setup();
    await t.auth.api.signUpEmail({
      body: { name: "Signup", email: "signup@example.test", password: "chosen-password-1" },
    });
    const userId = String(t.user("signup@example.test").id);
    // Not an invite: a link nobody mailed is no way in.
    await t.link(userId, "unmailed");
    await expect(t.reset("unmailed", "attacker-pass-1")).rejects.toMatchObject({
      body: { code: "INVALID_TOKEN" },
    });
    expect(t.user("signup@example.test")).toMatchObject({ emailVerified: false });

    const token = await t.forgot("signup@example.test");
    await t.reset(token, "chosen-password-2");
    expect(t.user("signup@example.test")).toMatchObject({
      emailVerified: true,
      provedEmail: "signup@example.test",
    });
    expect(proof.acceptInvites).toHaveBeenCalledWith({
      id: userId,
      email: "signup@example.test",
      emailVerified: true,
    });
  });

  it("refuses /admin/create-user outside users.invite, and any caller-verified new user", async () => {
    const t = setup();
    // An HTTP call never carries the invite scope; a sessionless server call without it is the
    // same request to the hook.
    await expect(
      t.auth.api.createUser({
        body: {
          name: "Chosen",
          email: "chosen@example.test",
          password: "admin-chosen-password",
          role: "user",
        },
      }),
    ).rejects.toMatchObject({ body: { code: "ADMIN_CREATE_USER_UNSUPPORTED" } });
    await expect(
      runWithAdminInviteLocale("en-US", () =>
        t.auth.api.createUser({
          body: {
            name: "Chosen",
            email: "chosen@example.test",
            password: "admin-chosen-password",
            role: "user",
            data: { emailVerified: true },
          },
        }),
      ),
    ).rejects.toMatchObject({ body: { code: "EMAIL_VERIFICATION_BY_MAIL_ONLY" } });
    expect(t.db.user ?? []).toHaveLength(0);
  });

  it("keeps public signup's verification mail and header-selected locale", async () => {
    const t = setup();
    await t.auth.api.signUpEmail({
      body: { name: "Signup", email: "signup@example.test", password: "chosen-password-1" },
      headers: new Headers({ "x-app-locale": "es-MX" }),
    });
    expect(t.user("signup@example.test")).toMatchObject({ locale: "es-MX", emailVerified: false });
    expect(t.verificationMail).toHaveBeenCalledTimes(1);
  });
});
