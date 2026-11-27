import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
const env = vi.hoisted(
  () =>
    ({ BETTER_AUTH_URL: "https://api.example.com" }) as {
      BETTER_AUTH_URL: string;
      CORS_ORIGIN?: string;
    },
);
vi.mock("@ws-model-proxy/env/server", () => ({ env }));
const authOptions = vi.hoisted(
  () => ({}) as { verification?: { storeIdentifier?: string }; secondaryStorage?: object },
);
vi.mock("@ws-model-proxy/auth", () => ({
  auth: {
    $context: Promise.resolve({
      baseURL: "https://api.example.com/api/auth",
      options: authOptions,
    }),
  },
}));

const { default: prisma } = await import("@ws-model-proxy/db");
const {
  createSetPasswordLink,
  INVITE_LINK_TTL_DAYS,
  INVITE_LINK_TTL_SECONDS,
  inviteCallbackUrl,
  markAdminInvited,
  SetPasswordLinkNotPendingError,
  SetPasswordLinkRefusedError,
} = await import("./set-password-link");

const db = prisma as unknown as {
  $transaction: MockInstance;
  $queryRaw: MockInstance;
  user: { findUnique: MockInstance };
  verification: { deleteMany: MockInstance; create: MockInstance; findFirst: MockInstance };
};

/** A pending invite's state (packages/auth password-reset-links.ts `isInvitePending`). */
const PENDING = {
  emailVerified: false,
  accounts: [{ providerId: "credential" }],
  sessions: [] as { id: string }[],
};

beforeEach(() => {
  vi.clearAllMocks();
  delete env.CORS_ORIGIN;
  delete authOptions.verification;
  delete authOptions.secondaryStorage;
  // The interactive transaction runs its callback against the same mock.
  db.$transaction.mockImplementation(async (operation: (tx: unknown) => unknown) => operation(db));
  db.$queryRaw.mockResolvedValue([{ acquired: true }]);
  db.user.findUnique.mockResolvedValue(PENDING);
  db.verification.deleteMany.mockResolvedValue({ count: 0 });
  db.verification.create.mockResolvedValue({ id: "v1" });
  // An account users.invite created and marked.
  db.verification.findFirst.mockResolvedValue({ id: "mark" });
});

/** The reset-password rows the writer created (the admin-invited mark aside). */
function resetRows(): { identifier: string; value: string; expiresAt: Date }[] {
  return db.verification.create.mock.calls
    .map((call) => call[0].data)
    .filter((data) => String(data.identifier).startsWith("reset-password:"));
}

describe("createSetPasswordLink", () => {
  const now = new Date("2026-11-04T12:00:00Z");

  // Better-Auth 1.7.14 `requestPasswordReset` stores exactly this row through
  // `internalAdapter.createVerificationValue`, and `resetPassword` looks up
  // `reset-password:<token>` and reads the user id from `value`.
  it("writes a Better-Auth reset-password row that expires after the invite TTL", async () => {
    const {
      url,
      token: returned,
      expiresAt,
    } = await createSetPasswordLink({
      userId: "u1",
      locale: "es-MX",
      now,
    });

    expect(INVITE_LINK_TTL_DAYS).toBe(7);
    expect(expiresAt).toEqual(new Date(now.getTime() + INVITE_LINK_TTL_SECONDS * 1000));
    const written = resetRows()[0];
    if (!written) throw new Error("no reset-password row written");
    expect(written.value).toBe("u1");
    expect(written.expiresAt).toEqual(expiresAt);
    expect(written.identifier).toMatch(/^reset-password:[A-Za-z0-9_-]{43}$/);

    // The link is Better-Auth's own token callback, redirecting to the web
    // reset page in the invitee's locale, flagged as an invite.
    const token = written.identifier.slice("reset-password:".length);
    // Returned for the mailed-link record (users.invite, after a successful send).
    expect(returned).toBe(token);
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(
      `https://api.example.com/api/auth/reset-password/${token}`,
    );
    expect(parsed.searchParams.get("callbackURL")).toBe(
      "https://api.example.com/es-MX/reset-password?invite=1",
    );
  });

  it("invalidates earlier links and writes the new one in one transaction, under a per-user lock", async () => {
    await createSetPasswordLink({ userId: "u1", locale: "en-US", now });

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    // The user's owner fence (packages/db acquireFences) — tagged template.
    const [strings, held] = db.$queryRaw.mock.calls[0] ?? [];
    expect((strings as string[]).join("?").trim()).toBe(
      "SELECT wsmp_acquire_fences(?::text[], ?) AS acquired",
    );
    expect(held).toEqual(["00:owner:u1"]);
    expect(db.verification.deleteMany).toHaveBeenCalledWith({
      where: { value: "u1", identifier: { startsWith: "reset-password:" } },
    });
    // Only reset links are deleted, and only the link is written (the mark is markAdminInvited's).
    expect(db.verification.deleteMany).toHaveBeenCalledTimes(1);
    expect(db.verification.create).toHaveBeenCalledTimes(1);
    const order = (mock: MockInstance) => mock.mock.invocationCallOrder[0] ?? 0;
    expect(order(db.$queryRaw)).toBeLessThan(order(db.verification.deleteMany));
    const resetCreate = db.verification.create.mock.calls.findIndex((call) =>
      String(call[0].data.identifier).startsWith("reset-password:"),
    );
    expect(order(db.verification.deleteMany)).toBeLessThan(
      db.verification.create.mock.invocationCallOrder[resetCreate] ?? 0,
    );
  });

  // An SSO-linked user given a set-password link could gain a password that
  // bypasses the IdP and its MFA.
  it("refuses a user with a non-credential account and writes nothing", async () => {
    db.user.findUnique.mockResolvedValue({
      ...PENDING,
      accounts: [{ providerId: "credential" }, { providerId: "oidc" }],
    });

    await expect(createSetPasswordLink({ userId: "u1", locale: "en-US", now })).rejects.toThrow(
      SetPasswordLinkRefusedError,
    );
    expect(db.verification.deleteMany).not.toHaveBeenCalled();
    expect(db.verification.create).not.toHaveBeenCalled();
  });

  // A resend that read the invite as pending, then raced the invitee's own password setup: the
  // reset marks the account verified under the same lock (packages/auth onPasswordReset), so the
  // writer, re-checking after taking the lock, mints nothing for the activated account.
  it.each([
    ["verified", { ...PENDING, emailVerified: true }],
    ["signed in", { ...PENDING, sessions: [{ id: "s1" }] }],
    ["gone", null],
  ])(
    "refuses once the account is %s, checked under the lock, and writes nothing",
    async (_n, row) => {
      db.user.findUnique.mockResolvedValue(row);

      await expect(createSetPasswordLink({ userId: "u1", locale: "en-US", now })).rejects.toThrow(
        SetPasswordLinkNotPendingError,
      );
      expect(db.user.findUnique).toHaveBeenCalledWith({
        where: { id: "u1" },
        select: {
          emailVerified: true,
          accounts: { select: { providerId: true }, take: 2 },
          sessions: { where: { expiresAt: { gt: now } }, select: { id: true }, take: 1 },
        },
      });
      const order = (mock: MockInstance) => mock.mock.invocationCallOrder[0] ?? 0;
      expect(order(db.$queryRaw)).toBeLessThan(order(db.user.findUnique));
      expect(db.verification.deleteMany).not.toHaveBeenCalled();
      expect(db.verification.create).not.toHaveBeenCalled();
    },
  );

  it("fails loudly if Better-Auth stops storing verification rows as plain Postgres rows", async () => {
    authOptions.verification = { storeIdentifier: "hashed" };
    await expect(createSetPasswordLink({ userId: "u1", locale: "en-US", now })).rejects.toThrow(
      /verification storage/,
    );
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("mints a different token every time", async () => {
    await createSetPasswordLink({ userId: "u1", locale: "en-US", now });
    await createSetPasswordLink({ userId: "u1", locale: "en-US", now });
    const [first, second] = resetRows().map((row) => row.identifier);
    expect(first).toMatch(/^reset-password:/);
    expect(second).toMatch(/^reset-password:/);
    expect(first).not.toBe(second);
  });
});

describe("the admin-invited mark", () => {
  // An unverified public sign-up looks like a pending invite otherwise: a link must not turn it
  // into an invite whose reset verifies it without mailbox proof.
  it("mints no link for an account users.invite did not mark, and writes nothing", async () => {
    db.verification.findFirst.mockResolvedValue(null);
    await expect(createSetPasswordLink({ userId: "u1", locale: "en-US" })).rejects.toThrow(
      SetPasswordLinkNotPendingError,
    );
    expect(db.verification.findFirst).toHaveBeenCalledWith({
      where: { identifier: "admin-invited:u1" },
      select: { id: true },
    });
    expect(db.verification.create).not.toHaveBeenCalled();
    expect(db.verification.deleteMany).not.toHaveBeenCalled();
  });

  it("markAdminInvited writes it once, under the owner fence, never expiring", async () => {
    db.verification.findFirst.mockResolvedValue(null);
    await markAdminInvited("u1");
    const [strings, held] = db.$queryRaw.mock.calls[0] ?? [];
    expect((strings as string[]).join("?").trim()).toBe(
      "SELECT wsmp_acquire_fences(?::text[], ?) AS acquired",
    );
    expect(held).toEqual(["00:owner:u1"]);
    expect(db.verification.create).toHaveBeenCalledWith({
      data: {
        identifier: "admin-invited:u1",
        value: "u1",
        expiresAt: new Date("9999-12-31T00:00:00.000Z"),
      },
      select: { id: true },
    });
    db.verification.create.mockClear();
    db.verification.findFirst.mockResolvedValue({ id: "mark" });
    await markAdminInvited("u1");
    expect(db.verification.create).not.toHaveBeenCalled();
  });
});

describe("inviteCallbackUrl", () => {
  it("lands on the web origin when the SPA is served from another host", () => {
    env.CORS_ORIGIN = "https://app.example.com";
    expect(inviteCallbackUrl("en-US")).toBe(
      "https://app.example.com/en-US/reset-password?invite=1",
    );
  });

  it("falls back to the default locale for an unsupported or missing tag", () => {
    expect(inviteCallbackUrl("../../evil")).toBe(
      "https://api.example.com/en-US/reset-password?invite=1",
    );
    expect(inviteCallbackUrl(undefined)).toBe(
      "https://api.example.com/en-US/reset-password?invite=1",
    );
  });
});
