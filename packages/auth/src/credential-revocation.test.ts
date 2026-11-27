import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthMiddleware } from "better-auth/api";
import { admin, twoFactor } from "better-auth/plugins";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const models = [
  "apiKey",
  "agentToken",
  "mcpGrant",
  "oauthRefreshToken",
  "oauthAccessToken",
] as const;
const db = vi.hoisted(() => {
  const memory: Record<string, Row[]> = {
    user: [],
    account: [],
    session: [],
    verification: [],
    twoFactor: [],
  };
  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (key === "OR" && Array.isArray(value))
        return value.some((condition: Row) => matches(row, condition));
      if (typeof value === "object" && value !== null) {
        if ("startsWith" in value)
          return typeof row[key] === "string" && row[key].startsWith(String(value.startsWith));
        if ("in" in value && Array.isArray(value.in)) return value.in.includes(row[key]);
      }
      return row[key] === value;
    });
  const updateMany = () => ({ updateMany: vi.fn(async () => ({ count: 1 })) });
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => [{ acquired: true }]),
    apiKey: updateMany(),
    agentToken: updateMany(),
    mcpGrant: {
      ...updateMany(),
      findFirst: vi.fn(),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Row }) => ({
        id: "gap-grant",
        revokedAt: null,
        ...data,
      })),
    },
    nodeEnrollmentCode: updateMany(),
    nodeCredential: updateMany(),
    oauthRefreshToken: updateMany(),
    oauthAccessToken: updateMany(),
    oauthConsent: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    verification: {
      findFirst: vi.fn(
        async ({ where }: { where: { identifier: string } }) =>
          memory.verification?.find((row) => row.identifier === where.identifier) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: Row }) =>
        (memory.verification ?? []).filter((row) => matches(row, where)),
      ),
      deleteMany: vi.fn(async ({ where }: { where: Row }) => {
        const rows = memory.verification ?? [];
        memory.verification = rows.filter((row) => !matches(row, where));
        return { count: rows.length - memory.verification.length };
      }),
    },
    user: {
      updateMany: vi.fn(
        async ({ where, data }: { where: { id: string; email: string }; data: Row }) => {
          const rows =
            memory.user?.filter((row) => row.id === where.id && row.email === where.email) ?? [];
          for (const row of rows) Object.assign(row, data);
          return { count: rows.length };
        },
      ),
    },
    session: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; userId: string; expiresAt: { gt: Date } } }) =>
          memory.session?.find(
            (row) =>
              row.id === where.id &&
              row.userId === where.userId &&
              row.expiresAt instanceof Date &&
              row.expiresAt > where.expiresAt.gt,
          ) ?? null,
      ),
      deleteMany: vi.fn(
        async ({
          where,
        }: {
          where: {
            userId?: string;
            impersonatedBy?: string;
            OR?: Array<{ userId?: string; impersonatedBy?: string }>;
          };
        }) => {
          const rows = memory.session ?? [];
          const matches = (condition: { userId?: string; impersonatedBy?: string }, row: Row) =>
            Object.entries(condition).every(([key, value]) => row[key] === value);
          memory.session = rows.filter(
            (row) => !(where.OR ?? [where]).some((condition) => matches(condition, row)),
          );
          return { count: rows.length - memory.session.length };
        },
      ),
    },
  };
  return {
    memory,
    tx,
    transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
  };
});
vi.mock("@ws-model-proxy/mailer", () => ({ renderResetPassword: vi.fn(), sendEmail: vi.fn() }));
vi.mock("@ws-model-proxy/db", () => ({
  default: { ...db.tx, $transaction: db.transaction },
}));

import { passwordChangeRevocationTarget, revokeUserCredentials } from "./credential-revocation";
import { issueMcpGrantClaims } from "./mcp-grant";
import { passwordResetOptions } from "./password-reset";
import { secureAccountBeforePasswordReset } from "./password-reset-before";
import { onUserBanned } from "./user-ban-listeners";

beforeEach(() => {
  vi.clearAllMocks();
  for (const table of Object.keys(db.memory)) db.memory[table] = [];
  for (const model of models) db.tx[model].updateMany.mockReset().mockResolvedValue({ count: 1 });
  db.tx.oauthConsent.deleteMany.mockResolvedValue({ count: 1 });
});
afterEach(() => vi.restoreAllMocks());

describe("password credential revocation", () => {
  it("revokes only this user's CLI/API credentials together under the owner fence", async () => {
    await revokeUserCredentials("u1");
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.tx.$queryRaw.mock.calls[0]?.slice(1)).toEqual([["00:owner:u1"], true]);
    for (const model of models) {
      const field = model.startsWith("oauth") ? "revoked" : "revokedAt";
      expect(db.tx[model].updateMany).toHaveBeenCalledExactlyOnceWith({
        where: { userId: "u1", [field]: null },
        data: { [field]: expect.any(Date) },
      });
      expect(db.tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        db.tx[model].updateMany.mock.invocationCallOrder[0]!,
      );
    }
    expect(db.tx.oauthConsent.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { userId: "u1" },
    });
    expect(db.tx.nodeEnrollmentCode.updateMany).not.toHaveBeenCalled();
    expect(db.tx.nodeCredential.updateMany).not.toHaveBeenCalled();
    expect(db.tx.session.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { impersonatedBy: "u1" },
    });
  });

  it.each(["pre-sweep", "post-sweep"] as const)(
    "%s kills real plugin pending 2FA challenges, OTPs, attempts and trusted devices",
    async (phase) => {
      let otp = "";
      let userId = "";
      let pendingHeaders = new Headers();
      let pendingIdentifiers: unknown[] = [];
      let sessionOtpIdentifier = "";
      let preSweepChecked = false;
      const cookies = (response: Response) => {
        expect(response.status).toBe(200);
        return new Headers({
          cookie: response.headers
            .getSetCookie()
            .map((value) => value.split(";")[0])
            .join("; "),
        });
      };
      const auth = betterAuth({
        baseURL: "https://reset.example.test",
        secret: "reset-test-secret-at-least-thirty-two-characters",
        database: memoryAdapter(db.memory),
        emailAndPassword: { enabled: true, ...passwordResetOptions(false, undefined) },
        plugins: [
          twoFactor({
            otpOptions: {
              storeOTP: "hashed",
              sendOTP: async (data) => {
                otp = data.otp;
              },
            },
          }),
        ],
        hooks: {
          before: createAuthMiddleware(async (ctx) => {
            await secureAccountBeforePasswordReset(ctx);
            if (ctx.path !== "/reset-password") return;
            expect(
              db.memory.verification?.some((row) => pendingIdentifiers.includes(row.identifier)),
            ).toBe(false);
            expect(
              db.memory.verification?.some(
                (row) => row.value === userId && String(row.identifier).startsWith("trust-device-"),
              ),
            ).toBe(false);
            preSweepChecked = true;
            if (phase === "post-sweep") {
              // Requests already in flight can leave 2FA records between sweeps.
              await trustSignIn();
              await beginChallenge();
            }
          }),
        },
        logger: { disabled: true },
      });
      const context = await auth.$context;
      const beginChallenge = async () => {
        pendingHeaders = cookies(
          await auth.api.signInEmail({
            body: { email: "two-factor@example.test", password: "old-password-1" },
            asResponse: true,
          }),
        );
        await auth.api.sendTwoFactorOTP({ headers: pendingHeaders, body: {} });
        const challenge = db.memory.verification?.find(
          (row) => row.value === userId && String(row.identifier).startsWith("2fa-"),
        );
        expect(challenge).toBeDefined();
        pendingIdentifiers = [
          challenge!.identifier,
          `2fa-otp-${challenge!.identifier}`,
          `2fa-attempts-${challenge!.identifier}`,
        ];
        for (const identifier of pendingIdentifiers)
          expect(db.memory.verification?.some((row) => row.identifier === identifier)).toBe(true);
      };
      const created = await auth.api.signUpEmail({
        body: { name: "Person", email: "two-factor@example.test", password: "old-password-1" },
      });
      userId = created.user.id;
      await context.internalAdapter.updateUser(userId, { twoFactorEnabled: true });
      const trustSignIn = async () => {
        // Control: the real plugin accepts a valid code and persists a trusted device.
        await beginChallenge();
        const trusted = await auth.api.verifyTwoFactorOTP({
          headers: pendingHeaders,
          body: { code: otp, trustDevice: true },
          asResponse: true,
        });
        const trustedHeaders = cookies(trusted);
        expect(
          db.memory.verification?.some(
            (row) => row.value === userId && String(row.identifier).startsWith("trust-device-"),
          ),
        ).toBe(true);
        // Authenticated OTP keys use userId!sessionId rather than a pending challenge.
        const session = await auth.api.getSession({ headers: trustedHeaders });
        expect(session).toBeTruthy();
        sessionOtpIdentifier = `2fa-otp-${userId}!${session!.session.id}`;
        await auth.api.sendTwoFactorOTP({ headers: trustedHeaders, body: {} });
        expect(db.memory.verification?.some((row) => row.identifier === sessionOtpIdentifier)).toBe(
          true,
        );
      };
      await trustSignIn();
      await beginChallenge();
      const unrelated = [
        { identifier: "2fa-other", value: "other-user" },
        { identifier: "2fa-attempts-2fa-other", value: "0" },
        { identifier: "2fa-otp-2fa-other", value: "hashed-code:0" },
        { identifier: "trust-device-other", value: "other-user" },
        { identifier: "2fa-otp-other-user!session", value: "hashed-code:0" },
        { identifier: `admin-invited:${userId}`, value: userId },
        { identifier: "email-verification:keep", value: userId },
      ];
      for (const row of unrelated)
        await context.internalAdapter.createVerificationValue({
          ...row,
          expiresAt: new Date(Date.now() + 60_000),
        });
      await context.internalAdapter.createVerificationValue({
        identifier: "reset-password:two-factor",
        value: userId,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await auth.api.resetPassword({
        body: { token: "two-factor", newPassword: "new-password-1" },
      });
      expect(preSweepChecked).toBe(true);
      for (const identifier of [...pendingIdentifiers, sessionOtpIdentifier])
        expect(db.memory.verification?.some((row) => row.identifier === identifier)).toBe(false);
      expect(
        db.memory.verification?.some(
          (row) => row.value === userId && String(row.identifier).startsWith("trust-device-"),
        ),
      ).toBe(false);
      for (const row of unrelated)
        expect(db.memory.verification).toEqual(
          expect.arrayContaining([expect.objectContaining(row)]),
        );
      // The still-valid second factor cannot redeem the old password step after recovery.
      const sessions = [...(db.memory.session ?? [])];
      await expect(
        auth.api.verifyTwoFactorOTP({
          headers: pendingHeaders,
          body: { code: otp, trustDevice: true },
        }),
      ).rejects.toMatchObject({
        status: "UNAUTHORIZED",
        body: { code: "INVALID_TWO_FACTOR_COOKIE" },
      });
      expect(db.memory.session).toEqual(sessions);
      expect(db.tx.verification.findMany).toHaveBeenCalledTimes(2);
      for (let sweep = 0; sweep < 2; sweep++) {
        expect(db.tx.$queryRaw.mock.invocationCallOrder[sweep]).toBeLessThan(
          db.tx.verification.findMany.mock.invocationCallOrder[sweep]!,
        );
        expect(db.tx.verification.findMany.mock.invocationCallOrder[sweep]).toBeLessThan(
          db.tx.verification.deleteMany.mock.invocationCallOrder[sweep]!,
        );
      }
    },
  );

  it("refuses a gap mint using the deleted session even when the post-sweep fails after reset commits", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let attempt: (() => Promise<Record<string, unknown>>) | undefined;
    let passwordBefore: unknown;
    let gapAttempted = false;
    let gapOutcome: unknown;
    const auth = betterAuth({
      baseURL: "https://reset.example.test",
      secret: "reset-test-secret-at-least-thirty-two-characters",
      database: memoryAdapter(db.memory),
      emailAndPassword: { enabled: true, ...passwordResetOptions(false, undefined) },
      hooks: {
        before: createAuthMiddleware(async (ctx) => {
          await secureAccountBeforePasswordReset(ctx);
          if (ctx.path === "/reset-password") {
            gapAttempted = true;
            // Pause before Better Auth changes the password or deletes sessions itself.
            expect(db.memory.account?.[0]?.password).toBe(passwordBefore);
            expect(attempt).toBeDefined();
            gapOutcome = await attempt!().then(
              () => "minted",
              (error: unknown) => error,
            );
            expect(db.memory.session?.some((row) => row.userId === "other-user")).toBe(true);
          }
        }),
      },
      logger: { disabled: true },
    });
    const created = await auth.api.signUpEmail({
      body: { name: "Person", email: "gap@example.test", password: "old-password-1" },
    });
    const context = await auth.$context;
    const session = db.memory.session?.[0];
    expect(session).toBeDefined();
    await context.internalAdapter.createSession(created.user.id);
    db.memory.session?.push({
      id: "other-session",
      userId: "other-user",
      expiresAt: new Date(Date.now() + 60_000),
    });
    passwordBefore = db.memory.account?.[0]?.password;
    attempt = () =>
      issueMcpGrantClaims({
        grantType: "authorization_code",
        userId: created.user.id,
        clientId: "gap-client",
        sessionId: String(session?.id),
        secret: "gap-test-secret",
      });
    // Control: the same production mint path accepts this session before the sweep.
    await expect(attempt()).resolves.toEqual({ mcp_grant_id: "gap-grant" });
    db.tx.mcpGrant.create.mockClear();
    await context.internalAdapter.createVerificationValue({
      identifier: "reset-password:gap",
      value: created.user.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    db.tx.apiKey.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error("post-sweep failed"));
    const response = await auth.handler(
      new Request("https://reset.example.test/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://reset.example.test" },
        body: JSON.stringify({ token: "gap", newPassword: "new-password-1" }),
      }),
    );
    expect(response.status).toBe(500);
    expect(gapAttempted).toBe(true);
    expect(gapOutcome).toMatchObject({ status: "UNAUTHORIZED" });
    expect(db.tx.mcpGrant.create).not.toHaveBeenCalled();
    expect(db.memory.account?.[0]?.password).not.toBe(passwordBefore);
    expect(await context.internalAdapter.findVerificationValue("reset-password:gap")).toBeNull();
    expect(db.memory.session?.filter((row) => row.userId === created.user.id)).toEqual([]);
    expect(db.tx.session.deleteMany).toHaveBeenNthCalledWith(1, {
      where: { OR: [{ userId: created.user.id }, { impersonatedBy: created.user.id }] },
    });
    expect(db.tx.session.deleteMany).toHaveBeenNthCalledWith(2, {
      where: { impersonatedBy: created.user.id },
    });
    expect(db.tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      db.tx.session.deleteMany.mock.invocationCallOrder[0]!,
    );
    expect(db.tx.apiKey.updateMany).toHaveBeenCalledTimes(2);
  });

  it("finalizes the invite and kills the second link after post-sweep retries fail, while reporting the error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const auth = betterAuth({
      baseURL: "https://reset.example.test",
      secret: "reset-test-secret-at-least-thirty-two-characters",
      database: memoryAdapter(db.memory),
      emailAndPassword: { enabled: true, ...passwordResetOptions(false, undefined) },
      hooks: { before: createAuthMiddleware(secureAccountBeforePasswordReset) },
      logger: { disabled: true },
    });
    const created = await auth.api.signUpEmail({
      body: { name: "Invitee", email: "invitee@example.test", password: "old-password-1" },
    });
    const context = await auth.$context;
    for (const identifier of ["admin-invited:", "reset-password:first", "reset-password:second"]) {
      await context.internalAdapter.createVerificationValue({
        identifier:
          identifier === "admin-invited:" ? `${identifier}${created.user.id}` : identifier,
        value: created.user.id,
        expiresAt: new Date(Date.now() + 60_000),
      });
    }
    expect(
      await context.internalAdapter.findVerificationValue("reset-password:second"),
    ).toBeTruthy();
    const passwordBefore = db.memory.account?.[0]?.password;
    const failure = Object.assign(new TypeError("private revocation failure"), { code: "P2034" });
    db.tx.apiKey.updateMany.mockResolvedValueOnce({ count: 1 });
    for (let attempt = 0; attempt < 5; attempt++)
      db.tx.apiKey.updateMany.mockRejectedValueOnce(failure);
    const response = await auth.handler(
      new Request("https://reset.example.test/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://reset.example.test" },
        body: JSON.stringify({ token: "first", newPassword: "new-password-1" }),
      }),
    );
    expect(response.status).toBe(500);
    expect(db.tx.apiKey.updateMany).toHaveBeenCalledTimes(6);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("SECURITY"),
      `user=${created.user.id}`,
      "TypeError",
    );
    expect(db.memory.account?.[0]?.password).not.toBe(passwordBefore);
    expect(await context.internalAdapter.findVerificationValue("reset-password:first")).toBeNull();
    expect(db.memory.user?.[0]?.emailVerified).toBe(true);
    expect(await context.internalAdapter.findVerificationValue("reset-password:second")).toBeNull();
    expect(db.tx.user.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: created.user.id, email: created.user.email },
      data: { emailVerified: true },
    });
    expect(db.tx.apiKey.updateMany.mock.invocationCallOrder[5]).toBeLessThan(
      db.tx.user.updateMany.mock.invocationCallOrder[0]!,
    );
  });

  it.each(["reset", "change-with-sign-out", "change-without-sign-out"] as const)(
    "%s revokes impersonation sessions only when recovery or sign-out was requested",
    async (operation) => {
      let actingAdmin = "";
      let targetUser = "";
      let impersonationHeaders = new Headers();
      let gapSessionToken = "";
      let preSweepChecked = false;
      const auth = betterAuth({
        baseURL: "https://reset.example.test",
        secret: "reset-test-secret-at-least-thirty-two-characters",
        database: memoryAdapter(db.memory),
        emailAndPassword: { enabled: true, ...passwordResetOptions(false, undefined) },
        plugins: [admin()],
        hooks: {
          before: createAuthMiddleware(async (ctx) => {
            await secureAccountBeforePasswordReset(ctx);
            if (ctx.path !== "/reset-password") return;
            expect(await auth.api.getSession({ headers: impersonationHeaders })).toBeNull();
            preSweepChecked = true;
            // A request already in flight can finish impersonating after the pre-sweep.
            const session = await ctx.context.internalAdapter.createSession(targetUser, true, {
              impersonatedBy: actingAdmin,
            });
            gapSessionToken = session.token;
          }),
          after: createAuthMiddleware(async (ctx) => {
            const userId = passwordChangeRevocationTarget({
              path: ctx.path,
              body: ctx.body,
              returned: ctx.context.returned,
            });
            if (userId) await revokeUserCredentials(userId);
          }),
        },
        logger: { disabled: true },
      });
      const cookieHeaders = (response: Response) => {
        expect(response.status).toBe(200);
        const cookies = new Map<string, string>();
        for (const cookie of response.headers.getSetCookie()) {
          const pair = cookie.split(";")[0]!;
          cookies.set(pair.slice(0, pair.indexOf("=")), pair);
        }
        return new Headers({ cookie: [...cookies.values()].join("; ") });
      };
      const adminResponse = await auth.api.signUpEmail({
        body: { name: "Admin", email: "admin@example.test", password: "old-password-1" },
        asResponse: true,
      });
      const adminHeaders = cookieHeaders(adminResponse);
      const context = await auth.$context;
      const adminSession = await auth.api.getSession({ headers: adminHeaders });
      actingAdmin = adminSession!.user.id;
      await context.internalAdapter.updateUser(actingAdmin, { role: "admin" });
      const targetResponse = await auth.api.signUpEmail({
        body: { name: "Target", email: "target@example.test", password: "target-password-1" },
        asResponse: true,
      });
      const targetHeaders = cookieHeaders(targetResponse);
      targetUser = (await auth.api.getSession({ headers: targetHeaders }))!.user.id;
      impersonationHeaders = cookieHeaders(
        await auth.api.impersonateUser({
          headers: adminHeaders,
          body: { userId: targetUser },
          asResponse: true,
        }),
      );
      expect(
        (await auth.api.getSession({ headers: impersonationHeaders }))?.session.impersonatedBy,
      ).toBe(actingAdmin);
      // Another admin's impersonation is outside this account's recovery scope.
      const unrelated = await context.internalAdapter.createSession(targetUser, true, {
        impersonatedBy: "another-admin",
      });
      let currentHeaders = adminHeaders;
      if (operation === "reset") {
        await context.internalAdapter.createVerificationValue({
          identifier: "reset-password:impersonation",
          value: actingAdmin,
          expiresAt: new Date(Date.now() + 60_000),
        });
        await auth.api.resetPassword({
          body: { token: "impersonation", newPassword: "new-password-1" },
        });
        expect(preSweepChecked).toBe(true);
        expect(gapSessionToken).not.toBe("");
        expect(await context.internalAdapter.findSession(gapSessionToken)).toBeNull();
        expect(await auth.api.getSession({ headers: adminHeaders })).toBeNull();
      } else {
        const response = await auth.api.changePassword({
          headers: adminHeaders,
          body: {
            currentPassword: "old-password-1",
            newPassword: "new-password-1",
            revokeOtherSessions: operation === "change-with-sign-out",
          },
          asResponse: true,
        });
        expect(response.status).toBe(200);
        if (operation === "change-with-sign-out") currentHeaders = cookieHeaders(response);
        expect(await auth.api.getSession({ headers: currentHeaders })).toBeTruthy();
      }
      const impersonation = await auth.api.getSession({ headers: impersonationHeaders });
      if (operation === "change-without-sign-out") expect(impersonation).toBeTruthy();
      else expect(impersonation).toBeNull();
      expect(await auth.api.getSession({ headers: targetHeaders })).toBeTruthy();
      expect(await context.internalAdapter.findSession(unrelated.token)).toBeTruthy();
    },
  );

  it("returns 503 on a pre-sweep token lookup failure with the password, token and sessions intact", async () => {
    const auth = betterAuth({
      baseURL: "https://reset.example.test",
      secret: "reset-test-secret-at-least-thirty-two-characters",
      database: memoryAdapter(db.memory),
      emailAndPassword: { enabled: true, ...passwordResetOptions(false, undefined) },
      hooks: { before: createAuthMiddleware(secureAccountBeforePasswordReset) },
      logger: { disabled: true },
    });
    const created = await auth.api.signUpEmail({
      body: { name: "Person", email: "lookup@example.test", password: "old-password-1" },
    });
    const context = await auth.$context;
    await context.internalAdapter.createVerificationValue({
      identifier: "reset-password:lookup",
      value: created.user.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const password = db.memory.account?.[0]?.password;
    const sessions = [...(db.memory.session ?? [])];
    const token = await context.internalAdapter.findVerificationValue("reset-password:lookup");
    vi.spyOn(context.internalAdapter, "findVerificationValue").mockRejectedValueOnce(
      new Error("private lookup details"),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await auth.handler(
      new Request("https://reset.example.test/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://reset.example.test" },
        body: JSON.stringify({ token: "lookup", newPassword: "new-password-1" }),
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      message:
        "We couldn't finish securing your account. Nothing was changed — try the link again.",
    });
    expect(db.memory.account?.[0]?.password).toBe(password);
    expect(db.memory.session).toEqual(sessions);
    expect(await context.internalAdapter.findVerificationValue("reset-password:lookup")).toEqual(
      token,
    );
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("closes an open stream through the ban announcement only after revocation commits", async () => {
    let committed = false;
    let notifiedAfterCommit = false;
    db.transaction.mockImplementationOnce(async (work) => {
      const result = await work(db.tx);
      committed = true;
      return result;
    });
    let unsubscribe = () => {};
    const stream = new ReadableStream({
      start(controller) {
        unsubscribe = onUserBanned((userId) => {
          if (userId !== "u1") return;
          notifiedAfterCommit = committed;
          controller.close();
        });
      },
    });
    const reader = stream.getReader();
    try {
      const reading = reader.read();
      await revokeUserCredentials("u1");
      expect(notifiedAfterCommit).toBe(true);
      expect(await reading).toMatchObject({ done: true });
    } finally {
      unsubscribe();
      await reader.cancel();
    }
  });

  it("exhausts serialization retries and logs only the user and failure class", async () => {
    const failure = Object.assign(new TypeError("secret database details"), { code: "P2034" });
    for (let attempt = 0; attempt < 5; attempt++) db.transaction.mockRejectedValueOnce(failure);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(revokeUserCredentials("u1")).rejects.toBe(failure);
    expect(db.transaction).toHaveBeenCalledTimes(5);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("SECURITY"),
      "user=u1",
      "TypeError",
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(failure.message);
  });

  it("retries serialization conflicts before announcing revocation", async () => {
    db.transaction.mockRejectedValueOnce(Object.assign(new Error("retry"), { code: "P2034" }));
    await revokeUserCredentials("u1");
    expect(db.transaction).toHaveBeenCalledTimes(2);
  });

  it.each(models)("logs and propagates a %s revocation failure", async (model) => {
    const failure = new TypeError("must not log secrets in error messages");
    failure.name = "must not log customized error names";
    db.tx[model].updateMany.mockRejectedValueOnce(failure);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(revokeUserCredentials("u1")).rejects.toBe(failure);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("SECURITY"),
      "user=u1",
      "TypeError",
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(failure.message);
    expect(JSON.stringify(log.mock.calls)).not.toContain(failure.name);
  });

  it("propagates consent removal failure", async () => {
    const failure = new Error("consent removal failed");
    db.tx.oauthConsent.deleteMany.mockRejectedValueOnce(failure);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(revokeUserCredentials("u1")).rejects.toBe(failure);
  });
});

describe("password change revocation target", () => {
  const success = { user: { id: "u1" } };
  it("selects only the successful change that requested sign-out", () => {
    expect(
      passwordChangeRevocationTarget({
        path: "/change-password",
        body: { revokeOtherSessions: true },
        returned: success,
      }),
    ).toBe("u1");
  });
  it.each([
    { path: "/change-password", body: { revokeOtherSessions: false }, returned: success },
    {
      path: "/change-password",
      body: { revokeOtherSessions: true },
      returned: new Error("refused"),
    },
    {
      path: "/change-password",
      body: { revokeOtherSessions: true },
      returned: { user: { id: "" } },
    },
    { path: "/change-password", body: null, returned: success },
    { path: "/sign-in/email", body: { revokeOtherSessions: true }, returned: success },
  ])("ignores an unrelated, failed or non-revoking request: %j", (ctx) => {
    expect(passwordChangeRevocationTarget(ctx)).toBeNull();
  });
});
