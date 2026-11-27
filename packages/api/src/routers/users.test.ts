import { createRouterClient, ORPCError } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { invalidateForceTwoFactorPolicyCache } from "@ws-model-proxy/auth/force-two-factor-policy";
import { onUserBanned } from "@ws-model-proxy/auth/user-ban-listeners";
import { onUserDeleted } from "@ws-model-proxy/auth/user-deletion-listeners";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Context } from "../context";
import { usersRouter } from "./users";

// Mock @ws-model-proxy/db before importing the module so the router pulls the deep-
// mocked Prisma client.
vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

// The durable, bounded user delete (preflight, intent, history drain, ordered
// capacity-graph delete) is exercised against real PostgreSQL in
// parent-deletion.postgres.integration.test.ts. Here it forwards to the mocked
// delete so the router's result and error mapping are testable; the error
// classes and the permanent-failure classifier are the real ones.
vi.mock("@ws-model-proxy/db/parent-deletion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ws-model-proxy/db/parent-deletion")>();
  const { default: client } = await import("@ws-model-proxy/db");
  const users = client as unknown as {
    user: { delete(args: { where: { id: string } }): Promise<unknown> };
  };
  return {
    ...actual,
    deleteUserDurably: vi.fn(async (_db: unknown, userId: string) => {
      await users.user.delete({ where: { id: userId } });
      return "deleted";
    }),
  };
});

vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_URL: "http://localhost:3000" },
  ADMIN_EMAIL: undefined,
}));

// Mock @ws-model-proxy/auth so the router's `auth.api.createUser` call hits a stub
// instead of pulling in the real better-auth (which needs an env, prisma, etc).
vi.mock("@ws-model-proxy/auth", () => ({
  auth: {
    api: {
      createUser: vi.fn(),
    },
  },
}));

// Mock @ws-model-proxy/mailer so invites don't try to open SMTP. Tests assert on the
// call shape via the mock instead. `renderInviteUser` is stubbed to return a
// stable subject/html so the router can pass them straight through to
// `sendEmail` — the actual rendering is tested in the mailer package.
vi.mock("../lib/set-password-link", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/set-password-link")>()),
  createSetPasswordLink: vi.fn(async () => ({
    url: "https://app.example.test/api/auth/reset-password/INVITE?callbackURL=x",
    token: "INVITE",
    expiresAt: new Date("2026-12-01T00:00:00Z"),
  })),
  markAdminInvited: vi.fn(async () => {}),
}));

// The mailed-link record (packages/auth password-reset-links.ts); the shared pending rule stays
// real.
vi.mock("@ws-model-proxy/auth/password-reset-links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ws-model-proxy/auth/password-reset-links")>()),
  recordResetLinkMailed: vi.fn(async () => true),
}));

vi.mock("@ws-model-proxy/mailer", () => ({
  isEmailConfigured: vi.fn(() => true),
  sendEmail: vi.fn(),
  renderInviteUser: vi.fn(() => ({
    subject: "You've been invited",
    html: "<html><body>invite</body></html>",
  })),
}));

const { default: prisma } = await import("@ws-model-proxy/db");
const { auth } = await import("@ws-model-proxy/auth");
const { isEmailConfigured, renderInviteUser, sendEmail } = await import("@ws-model-proxy/mailer");
const { deleteUserDurably } = await import("@ws-model-proxy/db/parent-deletion");

const db = prisma as unknown as {
  user: {
    findUnique: MockInstance;
    findMany: MockInstance;
    count: MockInstance;
    update: MockInstance;
    updateMany: MockInstance;
    delete: MockInstance;
  };
  session: { deleteMany: MockInstance };
  cliDeviceCredential: { findMany: MockInstance };
  cliToken: { findMany: MockInstance };
  appSetting: { findUnique: MockInstance };
  verification: { findMany: MockInstance };
  $transaction: MockInstance;
  $queryRaw: MockInstance;
  auditEvent: { create: MockInstance };
};

const authApi = auth as unknown as {
  api: { createUser: MockInstance };
};
const sendEmailMock = sendEmail as unknown as MockInstance;

function buildContext(
  sessionOverride?: Partial<{
    user: Partial<Session["user"]>;
    session: Partial<Session["session"]>;
  }> | null,
): Context {
  if (sessionOverride === null) return { session: null, auth: { kind: "anonymous" } };
  const userId = sessionOverride?.user?.id ?? "admin-user-id";
  return {
    auth: { kind: "cookie_session", userId, sessionId: "test-session-id", csrfVerified: true },
    session: {
      user: {
        id: "admin-user-id",
        email: "admin@example.com",
        name: "Admin",
        emailVerified: true,
        role: "admin",
        twoFactorEnabled: false,
        image: null,
        banned: false,
        banReason: null,
        banExpires: null,
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
        ...sessionOverride?.user,
      },
      session: {
        id: "test-session-id",
        userId: sessionOverride?.user?.id ?? "admin-user-id",
        token: "test-token",
        expiresAt: new Date(Date.now() + 86_400_000),
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
        ...sessionOverride?.session,
      },
    } as Session,
  };
}

/** Sentinels that must NEVER reach the captured console output. */
const SENTINEL = "SECRET-TOKEN-VALUE";

function sentinelError(label: string): Error {
  const err = new Error(
    `Invalid \`prisma.user.create()\` invocation: ${label} client_secret=${SENTINEL} SELECT "x"`,
  );
  err.stack = `Error: ${SENTINEL}\n    at create (introspect-CbhhXT0E.mjs:2542:15)`;
  return err;
}

/**
 * Capture console.error/warn output while `fn` runs. `fn` must contain
 * the PRODUCTION call ONLY — never assertions: a failed assertion thrown
 * inside this helper's await would otherwise need to (and does) propagate
 * unchanged. Assertions run outside, on the returned output (pass-11 fix
 * for the assertion-swallowing capture helper, R37/R38 finding 4).
 */
async function captureConsoleDuring(fn: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const toLine = (...args: unknown[]) => {
    chunks.push(args.map((a) => String(a)).join(" "));
  };
  const errorSpy = vi.spyOn(console, "error").mockImplementation(toLine);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(toLine);
  try {
    await fn();
  } finally {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  }
  return chunks.join("\n");
}

describe("usersRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction
      .mockReset()
      .mockImplementation(async (run: (tx: typeof prisma) => Promise<unknown>) => run(prisma));
    db.$queryRaw.mockReset().mockResolvedValue([{ count: 2 }]);
    db.auditEvent.create.mockReset().mockResolvedValue({});
    vi.mocked(isEmailConfigured).mockReturnValue(true);
    for (const mock of [
      db.user.findUnique,
      db.user.findMany,
      db.user.count,
      db.user.update,
      db.user.updateMany,
      db.user.delete,
      db.$transaction,
      db.session.deleteMany,
      db.cliDeviceCredential.findMany,
      db.cliToken.findMany,
      db.appSetting.findUnique,
    ])
      mock.mockClear();
    invalidateForceTwoFactorPolicyCache();
    // Current users.ts reads the signup-access gate via appSetting.
    db.appSetting.findUnique.mockResolvedValue(null);
    // Every listed / resent user is an admin invite unless a test says otherwise.
    db.verification.findMany.mockImplementation(
      async (args: { where: { identifier: { in: string[] } } }) =>
        args.where.identifier.in.map((identifier) => ({
          value: identifier.slice("admin-invited:".length),
        })),
    );
  });

  describe("auth gates", () => {
    it("list throws NOT_FOUND when no session", async () => {
      const client = createRouterClient(usersRouter, { context: buildContext(null) });
      await expect(client.list()).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("NOT_FOUND");
        return true;
      });
    });

    it("list throws NOT_FOUND for non-admin role", async () => {
      const client = createRouterClient(usersRouter, {
        context: buildContext({ user: { role: "user" } }),
      });
      await expect(client.list()).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("NOT_FOUND");
        return true;
      });
    });

    it("invite throws NOT_FOUND for non-admin role", async () => {
      const client = createRouterClient(usersRouter, {
        context: buildContext({ user: { role: "user" } }),
      });
      await expect(
        client.invite({ locale: "en-US", email: "x@example.com", name: "X" }),
      ).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("NOT_FOUND");
        return true;
      });
      expect(authApi.api.createUser).not.toHaveBeenCalled();
    });
  });

  describe("list", () => {
    it("returns users + total without a search filter", async () => {
      db.user.findMany.mockResolvedValue([
        {
          id: "1",
          email: "a@x.com",
          slug: "a",
          name: "A",
          role: "user",
          emailVerified: true,
          accounts: [{ providerId: "credential" }],
          sessions: [],
          banned: null,
          banReason: null,
          banExpires: null,
          deletionRequestedAt: null,
          twoFactorEnabled: null,
          createdAt: new Date("2026-01-01"),
        },
      ]);
      db.user.count.mockResolvedValue(1);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.list();

      expect(res.total).toBe(1);
      expect(res.users).toHaveLength(1);
      // No `where` clause when no search.
      expect(db.user.findMany.mock.calls[0]?.[0].where).toEqual({});
    });

    it("reports a pending invite only for an account users.invite created", async () => {
      const unverified = {
        email: "p@x.com",
        slug: "p",
        name: "P",
        role: "user",
        emailVerified: false,
        accounts: [{ providerId: "credential" }],
        sessions: [],
        banned: null,
        banReason: null,
        banExpires: null,
        deletionRequestedAt: null,
        twoFactorEnabled: null,
        createdAt: new Date("2026-01-01"),
      };
      db.user.findMany.mockResolvedValue([
        { ...unverified, id: "invited" },
        { ...unverified, id: "public-signup" },
      ]);
      db.user.count.mockResolvedValue(2);
      db.verification.findMany.mockResolvedValue([{ value: "invited" }]);
      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.list();
      expect(db.verification.findMany).toHaveBeenCalledWith({
        where: { identifier: { in: ["admin-invited:invited", "admin-invited:public-signup"] } },
        select: { value: true },
      });
      expect(res.users.map((user) => [user.id, user.invitePending])).toEqual([
        ["invited", true],
        ["public-signup", false],
      ]);
    });

    it("applies a case-insensitive OR search across name and email", async () => {
      db.user.findMany.mockResolvedValue([]);
      db.user.count.mockResolvedValue(0);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await client.list({ search: "alice", limit: 10, offset: 0 });

      const call = db.user.findMany.mock.calls[0]?.[0];
      expect(call.where).toEqual({
        OR: [
          { email: { contains: "alice", mode: "insensitive" } },
          { name: { contains: "alice", mode: "insensitive" } },
        ],
      });
      expect(call.take).toBe(10);
    });
  });

  describe("invite", () => {
    it("creates the user via better-auth and emails them on success", async () => {
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      sendEmailMock.mockResolvedValue(undefined);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.invite({
        locale: "en-US",
        email: "NEW@example.com",
        name: "New User",
        role: "user",
      });

      expect(res.userId).toBe("new-user-id");
      expect(res).toEqual({ userId: "new-user-id", emailSent: true });
      expect(res).not.toHaveProperty("tempPassword");
      // Marked an admin invite first, then the link.
      const { createSetPasswordLink, markAdminInvited } = await import("../lib/set-password-link");
      expect(markAdminInvited).toHaveBeenCalledWith("new-user-id");
      expect(createSetPasswordLink).toHaveBeenCalledWith({
        userId: "new-user-id",
        locale: "en-US",
      });
      expect(vi.mocked(markAdminInvited).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(createSetPasswordLink).mock.invocationCallOrder[0] ?? 0,
      );
      expect(sendEmailMock).toHaveBeenCalledTimes(1);
      expect(renderInviteUser).toHaveBeenCalledWith(
        expect.objectContaining({
          setPasswordUrl: expect.stringContaining("reset-password/"),
          locale: "en-US",
          expiresInDays: 7,
        }),
      );
      expect(vi.mocked(renderInviteUser).mock.calls[0]?.[0]).not.toHaveProperty("tempPassword");
      expect(res.emailSent).toBe(true);
      // Email should be lowercased by the input zod schema.
      expect(authApi.api.createUser).toHaveBeenCalledWith({
        body: {
          email: "new@example.com",
          name: "New User",
          password: expect.any(String),
          role: "user",
        },
      });
      expect(sendEmailMock).toHaveBeenCalledWith(
        expect.objectContaining({ to: "new@example.com" }),
      );
    });

    it("records the link as mailed only after the send, and a revealed one never", async () => {
      const { recordResetLinkMailed } = await import("@ws-model-proxy/auth/password-reset-links");
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      sendEmailMock.mockResolvedValue(undefined);
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await client.invite({ locale: "en-US", email: "new@example.com", name: "New" });
      expect(recordResetLinkMailed).toHaveBeenCalledWith({
        token: "INVITE",
        userId: "new-user-id",
        email: "new@example.com",
      });
      expect(vi.mocked(recordResetLinkMailed).mock.invocationCallOrder[0]).toBeGreaterThan(
        sendEmailMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );

      // The send failed (shown to the admin) or SMTP is off: spending it proves nothing.
      vi.mocked(recordResetLinkMailed).mockClear();
      sendEmailMock.mockRejectedValueOnce(new Error("smtp down"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(
        (await client.invite({ locale: "en-US", email: "b@example.com", name: "B" })).emailSent,
      ).toBe(false);
      vi.mocked(isEmailConfigured).mockReturnValueOnce(false);
      expect(
        (await client.invite({ locale: "en-US", email: "c@example.com", name: "C" })).emailSent,
      ).toBe(false);
      expect(recordResetLinkMailed).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("keeps an invite emailed when the mailed record fails, and never logs the link", async () => {
      const { recordResetLinkMailed } = await import("@ws-model-proxy/auth/password-reset-links");
      vi.mocked(recordResetLinkMailed).mockRejectedValueOnce(
        new TypeError("db down reset-password/INVITE"),
      );
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      sendEmailMock.mockResolvedValue(undefined);
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(
        client.invite({ locale: "en-US", email: "new@example.com", name: "New" }),
      ).resolves.toEqual({ userId: "new-user-id", emailSent: true });
      expect(error).toHaveBeenCalledWith(
        "[users.invite] failed to record the mailed invite link: TypeError",
      );
      expect(JSON.stringify(error.mock.calls)).not.toContain("INVITE");
      error.mockRestore();
    });

    it("returns emailSent=false when SMTP throws but the user was still created", async () => {
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      sendEmailMock.mockRejectedValue(new Error("SMTP not configured"));

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.invite({
        locale: "en-US",
        email: "new@example.com",
        name: "New User",
      });

      expect(res.emailSent).toBe(false);
      expect(res.userId).toBe("new-user-id");
    });

    it("stops with a clear next step when the invite cannot be marked, before any link", async () => {
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      const { createSetPasswordLink, markAdminInvited } = await import("../lib/set-password-link");
      vi.mocked(markAdminInvited).mockRejectedValueOnce(new Error("db down"));
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(
        client.invite({ locale: "en-US", email: "new@example.com", name: "New" }),
      ).rejects.toMatchObject({
        code: "INVITE_INCOMPLETE",
        status: 500,
        message: "Couldn't finish the invite. Remove this user and invite them again.",
      });
      expect(createSetPasswordLink).not.toHaveBeenCalled();
      expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it("keeps a failed first link resendable: the mark is already committed", async () => {
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      const { createSetPasswordLink, markAdminInvited } = await import("../lib/set-password-link");
      vi.mocked(createSetPasswordLink).mockRejectedValueOnce(new Error("tx failed"));
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(
        client.invite({ locale: "en-US", email: "new@example.com", name: "New" }),
      ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
      expect(markAdminInvited).toHaveBeenCalledWith("new-user-id");
    });

    it("carries the selected locale into account creation and mail, and rejects fr-FR", async () => {
      const { getAdminInviteLocale } = await import("@ws-model-proxy/auth/admin-invite-locale");
      authApi.api.createUser.mockImplementation(async () => {
        expect(getAdminInviteLocale()).toBe("es-MX");
        return { user: { id: "new-user-id" } };
      });
      sendEmailMock.mockResolvedValue(undefined);
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await client.invite({ locale: "es-MX", email: "new@example.com", name: "New" });
      expect(getAdminInviteLocale()).toBeUndefined();
      expect(renderInviteUser).toHaveBeenCalledWith(expect.objectContaining({ locale: "es-MX" }));
      await expect(
        client.invite({ locale: "fr-FR" as "en-US", email: "new@example.com", name: "New" }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(authApi.api.createUser).toHaveBeenCalledTimes(1);
    });

    it("without SMTP returns only a shareable link, with no delivery attempt", async () => {
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      vi.mocked(isEmailConfigured).mockReturnValue(false);
      const client = createRouterClient(usersRouter, { context: buildContext() });
      const result = await client.invite({
        locale: "en-US",
        email: "new@example.com",
        name: "New",
      });
      expect(result).toEqual({
        userId: "new-user-id",
        emailSent: false,
        setPasswordUrl: expect.stringContaining("reset-password/"),
        expiresAt: "2026-12-01T00:00:00.000Z",
      });
      expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it("translates a duplicate-email error code into a CONFLICT", async () => {
      // Better Auth's APIError carries its code in `body`.
      for (const failure of [
        Object.assign(new Error("opaque"), {
          body: { code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL", message: "opaque" },
        }),
        Object.assign(new Error("opaque"), { body: { code: "USER_ALREADY_EXISTS" } }),
        // A concurrent invite of the same email loses the unique index.
        Object.assign(new Error("opaque"), { code: "P2002" }),
        Object.assign(new Error("opaque"), { cause: { originalCode: "23505" } }),
      ]) {
        authApi.api.createUser.mockRejectedValueOnce(failure);
        const client = createRouterClient(usersRouter, { context: buildContext() });
        await expect(
          client.invite({ locale: "en-US", email: "dup@example.com", name: "Dup" }),
        ).rejects.toSatisfy((e: ORPCError) => {
          expect(e.code).toBe("CONFLICT");
          return true;
        });
      }
      expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it("never classifies an invite failure by message text", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        for (const message of [
          "User already exists",
          "Sign-up is currently disabled. Contact an admin if you need access.",
        ]) {
          authApi.api.createUser.mockRejectedValueOnce(new Error(message));
          const client = createRouterClient(usersRouter, { context: buildContext() });
          await expect(
            client.invite({ locale: "en-US", email: "new@example.com", name: "New User" }),
          ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
        }
      } finally {
        consoleError.mockRestore();
      }
    });

    it("surfaces a clear error if auth configuration blocks account creation", async () => {
      authApi.api.createUser.mockRejectedValue(
        Object.assign(new Error("opaque"), { code: "SIGNUP_DISABLED" }),
      );

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(
        client.invite({ locale: "en-US", email: "new@example.com", name: "New User" }),
      ).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("BAD_REQUEST");
        expect(e.message).toMatch(/account creation is disabled/i);
        return true;
      });
      expect(sendEmailMock).not.toHaveBeenCalled();
    });
  });

  describe("resendInvite", () => {
    const pending = {
      id: "pending",
      name: "Invitee",
      email: "invitee@example.test",
      locale: "es-MX",
      emailVerified: false,
      banned: false,
      banExpires: null,
      deletionRequestedAt: null,
      accounts: [{ providerId: "credential" }],
      sessions: [],
    };
    it("uses the stored locale and rotates the link through the same writer", async () => {
      db.user.findUnique.mockResolvedValue(pending);
      sendEmailMock.mockResolvedValue(undefined);
      const { createSetPasswordLink } = await import("../lib/set-password-link");
      const client = createRouterClient(usersRouter, { context: buildContext() });
      expect(await client.resendInvite({ userId: "pending" })).toEqual({
        userId: "pending",
        emailSent: true,
      });
      expect(createSetPasswordLink).toHaveBeenCalledWith({ userId: "pending", locale: "es-MX" });
      const { markAdminInvited } = await import("../lib/set-password-link");
      expect(markAdminInvited).not.toHaveBeenCalled();
      expect(sendEmailMock).toHaveBeenCalledTimes(1);
    });
    it("reports a setup that finished while the resend ran as no invite to resend", async () => {
      // The pre-check saw a pending invite; the writer, under the credential-setup lock, found the
      // account verified (the invitee set their password meanwhile).
      db.user.findUnique.mockResolvedValue(pending);
      const { createSetPasswordLink, SetPasswordLinkNotPendingError } = await import(
        "../lib/set-password-link"
      );
      vi.mocked(createSetPasswordLink).mockRejectedValueOnce(new SetPasswordLinkNotPendingError());
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.resendInvite({ userId: "pending" })).rejects.toMatchObject({
        code: "INVITE_NOT_PENDING",
        status: 409,
      });
      expect(sendEmailMock).not.toHaveBeenCalled();
    });
    it("refuses an unverified public sign-up (no admin-invited mark)", async () => {
      db.user.findUnique.mockResolvedValue(pending);
      db.verification.findMany.mockResolvedValue([]);
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.resendInvite({ userId: "pending" })).rejects.toMatchObject({
        code: "INVITE_NOT_PENDING",
      });
      const { createSetPasswordLink } = await import("../lib/set-password-link");
      expect(createSetPasswordLink).not.toHaveBeenCalled();
      expect(sendEmailMock).not.toHaveBeenCalled();
    });
    it("refuses verified, SSO, active-session, archived and deleting accounts", async () => {
      const client = createRouterClient(usersRouter, { context: buildContext() });
      for (const override of [
        { emailVerified: true },
        { accounts: [{ providerId: "oidc" }] },
        { sessions: [{ id: "live" }] },
        { banned: true },
        { deletionRequestedAt: new Date() },
      ]) {
        db.user.findUnique.mockResolvedValue({ ...pending, ...override });
        await expect(client.resendInvite({ userId: "pending" })).rejects.toBeInstanceOf(ORPCError);
      }
      expect(sendEmailMock).not.toHaveBeenCalled();
    });
    it("keeps the human-admin gate", async () => {
      const client = createRouterClient(usersRouter, {
        context: buildContext({ user: { role: "user" } }),
      });
      await expect(client.resendInvite({ userId: "pending" })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });
  });

  describe("setRole", () => {
    it("updates the role on a different user", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      db.user.update.mockResolvedValue({});

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.setRole({ userId: "other-user-id", role: "admin" });

      expect(res).toEqual({ success: true });
      expect(db.user.update).toHaveBeenCalledWith({
        where: { id: "other-user-id" },
        data: { role: "admin" },
      });
    });

    it("blocks the admin from demoting themselves", async () => {
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.setRole({ userId: "admin-user-id", role: "user" })).rejects.toSatisfy(
        (e: ORPCError) => {
          expect(e.code).toBe("FORBIDDEN");
          expect(e.message).toMatch(/own admin role/i);
          return true;
        },
      );
      expect(db.user.update).not.toHaveBeenCalled();
    });

    it("allows promoting yourself to admin (no-op safety net)", async () => {
      // Even though the admin is already admin, the schema allows the call.
      // We only block demotion of self — promoting yourself is harmless.
      db.user.findUnique.mockResolvedValue({ id: "admin-user-id", role: "admin" });
      db.user.update.mockResolvedValue({});

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.setRole({ userId: "admin-user-id", role: "admin" });
      expect(res).toEqual({ success: true });
    });

    it("throws NOT_FOUND for an unknown user id", async () => {
      db.user.findUnique.mockResolvedValue(null);
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.setRole({ userId: "missing", role: "user" })).rejects.toSatisfy(
        (e: ORPCError) => {
          expect(e.code).toBe("NOT_FOUND");
          return true;
        },
      );
    });
  });

  describe("archive", () => {
    it("bans the user and revokes their sessions in a transaction", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.archive({
        userId: "other-user-id",
        reason: "Inactive",
      });

      expect(res).toEqual({ success: true });
      expect(db.$transaction).toHaveBeenCalledOnce();
    });

    it("notifies the ban listeners after the ban committed, and never for a failed or refused archive (#159)", async () => {
      const order: string[] = [];
      const unsubscribe = onUserBanned((userId) => {
        order.push(`notified:${userId}`);
      });
      try {
        db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
        db.$transaction.mockImplementation(async (run: (tx: typeof prisma) => Promise<unknown>) => {
          const result = await run(prisma);
          order.push("committed");
          return result;
        });
        const client = createRouterClient(usersRouter, { context: buildContext() });
        await client.archive({ userId: "other-user-id" });
        expect(order).toEqual(["committed", "notified:other-user-id"]);

        // The transaction fails: no ban happened, so nothing is cancelled.
        order.length = 0;
        db.$transaction.mockRejectedValueOnce(new Error("db down"));
        await expect(client.archive({ userId: "other-user-id" })).rejects.toThrow();
        // Refused (self-archive) and unknown users: no ban, no notification.
        await expect(client.archive({ userId: "admin-user-id" })).rejects.toBeDefined();
        db.user.findUnique.mockResolvedValueOnce(null);
        await expect(client.archive({ userId: "missing-user-id" })).rejects.toBeDefined();
        expect(order).toEqual([]);
      } finally {
        unsubscribe();
      }
    });

    it("still reports success when a ban listener fails (the ban stands)", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const unsubscribe = onUserBanned(() => {
        throw new TypeError("boom");
      });
      try {
        db.user.findUnique.mockResolvedValue({ id: "other-user-id" });

        const client = createRouterClient(usersRouter, { context: buildContext() });
        await expect(client.archive({ userId: "other-user-id" })).resolves.toEqual({
          success: true,
        });
        expect(error).toHaveBeenCalledWith("[auth] user banned listener failed", "TypeError");
      } finally {
        unsubscribe();
        error.mockRestore();
      }
    });

    it("blocks self-archive", async () => {
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.archive({ userId: "admin-user-id" })).rejects.toSatisfy(
        (e: ORPCError) => {
          expect(e.code).toBe("FORBIDDEN");
          return true;
        },
      );
      expect(db.$transaction).not.toHaveBeenCalled();
    });
  });

  describe("unarchive", () => {
    it("clears banned + banReason + banExpires with one statement conditional on no marker", async () => {
      db.user.updateMany.mockResolvedValue({ count: 1 });

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.unarchive({ userId: "other-user-id" });

      expect(res).toEqual({ success: true });
      expect(db.user.updateMany).toHaveBeenCalledWith({
        where: { id: "other-user-id", deletionRequestedAt: null },
        data: { banned: false, banReason: null, banExpires: null },
      });
      expect(db.user.update).not.toHaveBeenCalled();
    });

    it("refuses unarchive while a deletion marker is present", async () => {
      // The conditional write matched nothing (the marker is set), the row exists.
      db.user.updateMany.mockResolvedValue({ count: 0 });
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.unarchive({ userId: "other-user-id" })).rejects.toSatisfy(
        (e: ORPCError) => {
          expect(e.code).toBe("CONFLICT");
          expect(e.message).toMatch(/being deleted/i);
          expect(e.data).toEqual({ reason: "deletion_in_progress" });
          return true;
        },
      );
      expect(db.user.update).not.toHaveBeenCalled();
    });

    it("returns NOT_FOUND for a missing user", async () => {
      db.user.updateMany.mockResolvedValue({ count: 0 });
      db.user.findUnique.mockResolvedValue(null);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.unarchive({ userId: "other-user-id" })).rejects.toSatisfy(
        (e: ORPCError) => {
          expect(e.code).toBe("NOT_FOUND");
          return true;
        },
      );
    });
  });

  describe("remove", () => {
    const deletedUsers: string[] = [];
    let unsubscribe: () => void = () => undefined;
    beforeEach(() => {
      deletedUsers.length = 0;
      unsubscribe = onUserDeleted((userId) => {
        deletedUsers.push(userId);
      });
    });
    afterEach(() => unsubscribe());

    it("notifies user-deletion listeners (live relay session close) after the delete", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      let deletedBeforeNotify = false;
      db.user.delete.mockImplementation(async () => {
        deletedBeforeNotify = deletedUsers.length === 0;
        return {};
      });

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await client.remove({ userId: "other-user-id" });

      expect(deletedUsers).toEqual(["other-user-id"]);
      expect(deletedBeforeNotify).toBe(true);
      // Matching is by user id at close time, not by a credential snapshot.
      expect(db.cliDeviceCredential.findMany).not.toHaveBeenCalled();
      expect(db.cliToken.findMany).not.toHaveBeenCalled();
    });

    it("notifies no listener when the delete fails", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      db.user.delete.mockRejectedValue(new Error("Foreign key constraint violated"));

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.remove({ userId: "other-user-id" })).rejects.toBeInstanceOf(ORPCError);
      expect(deletedUsers).toEqual([]);
    });

    it("hard-deletes when no FK constraint blocks it", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      db.user.delete.mockResolvedValue({});

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.remove({ userId: "other-user-id" });

      expect(res).toEqual({ success: true, pending: false });
      expect(deleteUserDurably).toHaveBeenCalledWith(prisma, "other-user-id", expect.any(Object));
      expect(db.user.delete).toHaveBeenCalledWith({ where: { id: "other-user-id" } });
    });

    it("reports a durable pending delete without notifying listeners yet", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      vi.mocked(deleteUserDurably).mockResolvedValueOnce("pending");

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.remove({ userId: "other-user-id" });

      expect(res).toEqual({ success: true, pending: true });
      expect(deletedUsers).toEqual([]);
    });

    it("tags a deletion abandoned by a permanent refusal as retained_history", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      vi.mocked(deleteUserDurably).mockResolvedValueOnce("abandoned");

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.remove({ userId: "other-user-id" })).rejects.toMatchObject({
        code: "CONFLICT",
        data: { reason: "retained_history" },
      });
      expect(deletedUsers).toEqual([]);
    });

    it("blocks self-delete", async () => {
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.remove({ userId: "admin-user-id" })).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("FORBIDDEN");
        return true;
      });
      expect(db.user.delete).not.toHaveBeenCalled();
    });

    it("converts a Prisma FK error code (P2003) into a CONFLICT with archive guidance", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      db.user.delete.mockRejectedValue(
        Object.assign(new Error("opaque"), { code: "P2003", meta: { modelName: "User" } }),
      );

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.remove({ userId: "other-user-id" })).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("CONFLICT");
        expect(e.message).toMatch(/archive/i);
        expect(e.data).toEqual({ reason: "retained_history" });
        return true;
      });
    });

    it("converts a driver SQLSTATE 23503 (wrapped) into a CONFLICT", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      db.user.delete.mockRejectedValue(
        Object.assign(new Error("opaque"), {
          code: "P2010",
          meta: { driverAdapterError: { cause: { originalCode: "23503" } } },
        }),
      );

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.remove({ userId: "other-user-id" })).rejects.toMatchObject({
        code: "CONFLICT",
        data: { reason: "retained_history" },
      });
    });

    it("never classifies by message text: an FK-sounding message without a code is an internal error", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      db.user.delete.mockRejectedValue(
        new Error("Foreign key constraint violated on the field: `Post_authorId_fkey`"),
      );
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const client = createRouterClient(usersRouter, { context: buildContext() });
        await expect(client.remove({ userId: "other-user-id" })).rejects.toMatchObject({
          code: "INTERNAL_SERVER_ERROR",
        });
      } finally {
        consoleError.mockRestore();
      }
    });
  });

  // ---------------------------------------------------------------------
  // Pass-10 logging-sink regressions (L19 invariant 10) — kept ADDITIVELY
  // alongside the restored behavioral regressions above. Assertions run
  // OUTSIDE the console-capture helper so a wrong error kind FAILS the
  // test (pass-11 fix for the assertion-swallowing helper, R37/R38).
  // ---------------------------------------------------------------------

  describe("users.invite — auth.api.createUser failure sink (pass 10)", () => {
    it("logs the constructor name ONLY — sentinel message/stack never reach console.error, error kind INTERNAL_SERVER_ERROR enforced", async () => {
      vi.mocked(auth.api.createUser).mockRejectedValue(sentinelError("invite"));
      const client = createRouterClient(usersRouter, { context: buildContext() });

      let caught: unknown;
      const output = await captureConsoleDuring(async () => {
        try {
          await client.invite({ locale: "en-US", email: "new@example.com", name: "New User" });
        } catch (err) {
          caught = err;
        }
      });

      // Mutation-sensitive error-kind pin — runs OUTSIDE the capture.
      expect(caught).toBeInstanceOf(ORPCError);
      expect((caught as ORPCError).code).toBe("INTERNAL_SERVER_ERROR");

      expect(output).toContain("[users.invite] auth.api.createUser failed: Error");
      expect(output).not.toContain(SENTINEL);
      expect(output).not.toContain("client_secret");
      expect(output).not.toContain("SELECT");
    });

    it("logs only ONE string argument (no raw error object appended)", async () => {
      vi.mocked(auth.api.createUser).mockRejectedValue(sentinelError("invite-arity"));
      const client = createRouterClient(usersRouter, { context: buildContext() });

      const calls: unknown[][] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        calls.push(args);
      });
      try {
        await client
          .invite({ locale: "en-US", email: "new@example.com", name: "New User" })
          .catch(() => {});
      } finally {
        spy.mockRestore();
      }
      expect(calls).toEqual([["[users.invite] auth.api.createUser failed: Error"]]);
    });

    it("invite-email failure sink logs the constructor name only (same class)", async () => {
      vi.mocked(auth.api.createUser).mockResolvedValue({ user: { id: "u1" } } as never);
      db.user.findUnique.mockResolvedValue({ locale: "en-US" });
      // renderInviteUser is invoked synchronously in users.ts — inject the
      // sentinel via a sync throw so the catch arm actually runs.
      vi.mocked(renderInviteUser).mockImplementation(() => {
        throw sentinelError("mailer");
      });
      vi.mocked(sendEmail).mockResolvedValue(undefined);
      const client = createRouterClient(usersRouter, { context: buildContext() });

      let result: { emailSent: boolean; userId: string } | undefined;
      const output = await captureConsoleDuring(async () => {
        result = await client.invite({
          locale: "en-US",
          email: "new@example.com",
          name: "New User",
        });
      });
      // Restore the default render stub for later tests.
      vi.mocked(renderInviteUser).mockReset();

      expect(output).toContain("[users.invite] failed to send invite email: Error");
      expect(output).not.toContain(SENTINEL);
      expect(output).not.toContain("client_secret");
      expect(result?.emailSent).toBe(false);
      expect(result?.userId).toBe("u1");
    });
  });

  describe("users.remove — prisma delete failure sink (pass 10 sibling)", () => {
    beforeEach(() => {
      db.cliDeviceCredential.findMany.mockResolvedValue([]);
      db.cliToken.findMany.mockResolvedValue([]);
    });

    it("logs the constructor name ONLY — Prisma SQL sentinel never reaches console.error, error kind INTERNAL_SERVER_ERROR enforced", async () => {
      db.user.findUnique.mockResolvedValue({ id: "target-id" });
      db.user.delete.mockRejectedValue(sentinelError("remove"));
      const client = createRouterClient(usersRouter, { context: buildContext() });

      let caught: unknown;
      const output = await captureConsoleDuring(async () => {
        try {
          await client.remove({ userId: "target-id" });
        } catch (err) {
          caught = err;
        }
      });

      expect(caught).toBeInstanceOf(ORPCError);
      expect((caught as ORPCError).code).toBe("INTERNAL_SERVER_ERROR");

      expect(output).toContain("[users.remove] prisma delete failed: Error");
      expect(output).not.toContain(SENTINEL);
      expect(output).not.toContain("client_secret");
      expect(output).not.toContain("SELECT");
    });
  });
});

describe("user access removal guard and role auditing", () => {
  const target = {
    id: "other-user-id",
    role: "admin",
    emailVerified: true,
    banned: false,
    banExpires: null,
    deletionRequestedAt: null,
  };
  const client = () => createRouterClient(usersRouter, { context: buildContext() });
  beforeEach(() => {
    vi.clearAllMocks();
    db.user.findUnique.mockReset().mockResolvedValue(target);
    db.$queryRaw.mockReset().mockResolvedValue([{ count: 2 }]);
    db.$transaction
      .mockReset()
      .mockImplementation(async (run: (tx: typeof prisma) => Promise<unknown>) => run(prisma));
    db.auditEvent.create.mockReset().mockResolvedValue({});
    invalidateForceTwoFactorPolicyCache();
    db.appSetting.findUnique.mockResolvedValue(null);
  });
  it.each(["setRole", "archive", "remove"] as const)(
    "%s refuses the last verified active admin inside its write transaction",
    async (operation) => {
      db.$queryRaw.mockResolvedValue([{ count: 1 }]);
      if (operation === "remove") {
        // The real deletion entry point invokes this callback inside its mark transaction.
        vi.mocked(deleteUserDurably).mockImplementationOnce(async (_db, _id, options) => {
          await prisma.$transaction(
            async (tx) => {
              await options?.beforeMark?.(tx);
            },
            { isolationLevel: "Serializable" },
          );
          return "deleted";
        });
      }
      const action =
        operation === "setRole"
          ? client().setRole({ userId: target.id, role: "user" })
          : client()[operation]({ userId: target.id });
      await expect(action).rejects.toMatchObject({
        code: "FORBIDDEN",
        data: { reason: "LAST_ACTIVE_ADMIN" },
      });
      expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: "Serializable",
      });
      expect(db.user.update).not.toHaveBeenCalled();
      expect(db.user.delete).not.toHaveBeenCalled();
      expect(db.session.deleteMany).not.toHaveBeenCalled();
      expect(db.auditEvent.create).not.toHaveBeenCalled();
    },
  );
  it.each(["user", "admin", "user, Admin"])(
    "audits a committed change from %s inside the same transaction",
    async (role) => {
      db.user.findUnique.mockResolvedValue({ ...target, role });
      const next = role === "user" ? "admin" : "user";
      await client().setRole({ userId: target.id, role: next });
      expect(db.auditEvent.create).toHaveBeenCalledExactlyOnceWith({
        data: {
          userId: target.id,
          actor: "USER",
          actorUserId: "admin-user-id",
          action: "users.role_changed",
          resourceType: "user",
          resourceId: target.id,
          before: { role },
          after: { role: next },
        },
      });
      expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: "Serializable",
      });
    },
  );
  it.each(["user", "admin"] as const)(
    "same-role %s requests write and audit nothing",
    async (role) => {
      db.user.findUnique.mockResolvedValue({ ...target, role });
      await client().setRole({ userId: target.id, role });
      expect(db.user.update).not.toHaveBeenCalled();
      expect(db.auditEvent.create).not.toHaveBeenCalled();
    },
  );
  it("recounts on every demotion and includes an expired temporary ban", async () => {
    db.user.findUnique.mockResolvedValue({ ...target, banned: true, banExpires: new Date(0) });
    db.$queryRaw.mockResolvedValueOnce([{ count: 2 }]).mockResolvedValueOnce([{ count: 1 }]);
    await client().setRole({ userId: target.id, role: "user" });
    await expect(client().setRole({ userId: target.id, role: "user" })).rejects.toMatchObject({
      data: { reason: "LAST_ACTIVE_ADMIN" },
    });
    expect(db.user.update).toHaveBeenCalledOnce();
    expect(db.auditEvent.create).toHaveBeenCalledOnce();
  });
  it.each(["setRole", "archive", "remove"] as const)(
    "%s translates serialization conflicts",
    async (operation) => {
      if (operation === "remove")
        vi.mocked(deleteUserDurably).mockRejectedValueOnce({ code: "P2034" });
      else db.$transaction.mockRejectedValueOnce({ code: "P2034" });
      const action =
        operation === "setRole"
          ? client().setRole({ userId: target.id, role: "user" })
          : client()[operation]({ userId: target.id });
      await expect(action).rejects.toMatchObject({
        code: "CONFLICT",
        data: { reason: "USER_CHANGE_CONFLICT" },
      });
      expect(db.auditEvent.create).not.toHaveBeenCalled();
    },
  );
  it.each([{ emailVerified: false }, { banned: true }, { deletionRequestedAt: new Date() }])(
    "does not count unusable admins as active: %s",
    async (change) => {
      db.user.findUnique.mockResolvedValue({ ...target, ...change });
      db.$queryRaw.mockResolvedValue([{ count: 0 }]);
      await expect(client().setRole({ userId: target.id, role: "user" })).resolves.toEqual({
        success: true,
      });
      expect(db.$queryRaw).not.toHaveBeenCalled();
    },
  );
});
