import { createRouterClient, ORPCError } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { invalidateForceTwoFactorPolicyCache } from "@ws-model-proxy/auth/force-two-factor-policy";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Context } from "../context";
import { usersRouter } from "./users";

// Mock @ws-model-proxy/db before importing the module so the router pulls the deep-
// mocked Prisma client.
vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_URL: "http://localhost:3000" },
  ADMIN_EMAILS: new Set<string>(),
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
vi.mock("@ws-model-proxy/mailer", () => ({
  sendEmail: vi.fn(),
  renderInviteUser: vi.fn(() => ({
    subject: "You've been invited",
    html: "<html><body>invite</body></html>",
  })),
}));

const { default: prisma } = await import("@ws-model-proxy/db");
const { auth } = await import("@ws-model-proxy/auth");
const { renderInviteUser, sendEmail } = await import("@ws-model-proxy/mailer");

const db = prisma as unknown as {
  user: {
    findUnique: MockInstance;
    findMany: MockInstance;
    count: MockInstance;
    update: MockInstance;
    delete: MockInstance;
  };
  session: { deleteMany: MockInstance };
  appSetting: { findUnique: MockInstance };
  $transaction: MockInstance;
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
  if (sessionOverride === null) return { session: null };
  return {
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
    invalidateForceTwoFactorPolicyCache();
    // Current users.ts reads the signup-access gate via appSetting.
    db.appSetting.findUnique.mockResolvedValue(null);
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
      await expect(client.invite({ email: "x@example.com", name: "X" })).rejects.toSatisfy(
        (e: ORPCError) => {
          expect(e.code).toBe("NOT_FOUND");
          return true;
        },
      );
      expect(authApi.api.createUser).not.toHaveBeenCalled();
    });
  });

  describe("list", () => {
    it("returns users + total without a search filter", async () => {
      db.user.findMany.mockResolvedValue([{ id: "1", email: "a@x.com", name: "A", role: "user" }]);
      db.user.count.mockResolvedValue(1);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.list();

      expect(res.total).toBe(1);
      expect(res.users).toHaveLength(1);
      // No `where` clause when no search.
      expect(db.user.findMany.mock.calls[0]?.[0].where).toEqual({});
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
        email: "NEW@example.com",
        name: "New User",
        role: "user",
      });

      expect(res.userId).toBe("new-user-id");
      expect(res.tempPassword).toEqual(expect.any(String));
      expect(res.tempPassword.length).toBeGreaterThan(8);
      expect(res.emailSent).toBe(true);
      // Email should be lowercased by the input zod schema.
      expect(authApi.api.createUser).toHaveBeenCalledWith({
        body: {
          email: "new@example.com",
          name: "New User",
          password: res.tempPassword,
          role: "user",
        },
      });
      expect(sendEmailMock).toHaveBeenCalledWith(
        expect.objectContaining({ to: "new@example.com" }),
      );
    });

    it("returns emailSent=false when SMTP throws but the user was still created", async () => {
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      sendEmailMock.mockRejectedValue(new Error("SMTP not configured"));

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.invite({
        email: "new@example.com",
        name: "New User",
      });

      expect(res.emailSent).toBe(false);
      expect(res.userId).toBe("new-user-id");
    });

    it("translates a duplicate-email error into a CONFLICT", async () => {
      authApi.api.createUser.mockRejectedValue(new Error("User already exists"));

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.invite({ email: "dup@example.com", name: "Dup" })).rejects.toSatisfy(
        (e: ORPCError) => {
          expect(e.code).toBe("CONFLICT");
          return true;
        },
      );
      expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it("surfaces a clear error if auth configuration blocks account creation", async () => {
      authApi.api.createUser.mockRejectedValue(
        new Error("Sign-up is currently disabled. Contact an admin if you need access."),
      );

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.invite({ email: "new@example.com", name: "New User" })).rejects.toSatisfy(
        (e: ORPCError) => {
          expect(e.code).toBe("BAD_REQUEST");
          expect(e.message).toMatch(/account creation is disabled/i);
          return true;
        },
      );
      expect(sendEmailMock).not.toHaveBeenCalled();
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
      db.user.findUnique.mockResolvedValue({ id: "admin-user-id" });
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
      db.$transaction.mockResolvedValue([]);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.archive({
        userId: "other-user-id",
        reason: "Inactive",
      });

      expect(res).toEqual({ success: true });
      expect(db.$transaction).toHaveBeenCalledOnce();
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
    it("clears banned + banReason + banExpires", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      db.user.update.mockResolvedValue({});

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.unarchive({ userId: "other-user-id" });

      expect(res).toEqual({ success: true });
      expect(db.user.update).toHaveBeenCalledWith({
        where: { id: "other-user-id" },
        data: { banned: false, banReason: null, banExpires: null },
      });
    });
  });

  describe("remove", () => {
    it("hard-deletes when no FK constraint blocks it", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      db.user.delete.mockResolvedValue({});

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.remove({ userId: "other-user-id" });

      expect(res).toEqual({ success: true });
      expect(db.user.delete).toHaveBeenCalledWith({ where: { id: "other-user-id" } });
    });

    it("blocks self-delete", async () => {
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.remove({ userId: "admin-user-id" })).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("FORBIDDEN");
        return true;
      });
      expect(db.user.delete).not.toHaveBeenCalled();
    });

    it("converts a Prisma FK constraint error into a CONFLICT with archive guidance", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      db.user.delete.mockRejectedValue(
        new Error("Foreign key constraint violated on the field: `Post_authorId_fkey`"),
      );

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.remove({ userId: "other-user-id" })).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("CONFLICT");
        expect(e.message).toMatch(/archive/i);
        return true;
      });
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
          await client.invite({ email: "new@example.com", name: "New User" });
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
        await client.invite({ email: "new@example.com", name: "New User" }).catch(() => {});
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
        result = await client.invite({ email: "new@example.com", name: "New User" });
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
