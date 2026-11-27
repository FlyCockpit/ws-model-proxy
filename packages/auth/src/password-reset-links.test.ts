import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A recording Prisma stub: every call lands in `calls` in order, answers come from `answers`.
const stub = vi.hoisted(() => {
  const calls: string[] = [];
  const answers: Record<string, (args: Record<string, unknown>) => unknown> = {};
  const op =
    (name: string) =>
    async (args: Record<string, unknown> = {}) => {
      calls.push(`${name} ${JSON.stringify(args)}`);
      return answers[name]?.(args) ?? null;
    };
  const tx = {
    $queryRaw: vi.fn(async (_strings: TemplateStringsArray, held: string[]) => {
      calls.push(`lock ${JSON.stringify(held)}`);
      return [{ acquired: true }];
    }),
    user: { findUnique: op("user.findUnique"), updateMany: op("user.updateMany") },
    verification: {
      findFirst: op("verification.findFirst"),
      create: op("verification.create"),
      deleteMany: op("verification.deleteMany"),
    },
  };
  const client = {
    ...tx,
    $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => {
      calls.push("begin");
      const result = await operation(tx);
      calls.push("commit");
      return result;
    }),
  };
  return { calls, answers, client };
});
vi.mock("@ws-model-proxy/db", () => ({ default: stub.client }));

const {
  isInvitePending,
  isResetLinkRedeemable,
  recordResetLinkMailed,
  resetTokenOf,
  admitResetSpend,
} = await import("./password-reset-links");

const NOW = new Date("2026-11-27T12:00:00.000Z");
const LATER = new Date("2026-11-27T13:00:00.000Z");
const mailedId = (token: string) =>
  `reset-password-mailed:${createHash("sha256").update(token).digest("base64url")}`;
const LOCK = 'lock ["00:owner:u1"]';
const pendingState = {
  emailVerified: false,
  accounts: [{ providerId: "credential" }],
  sessions: [],
};

beforeEach(() => {
  stub.calls.length = 0;
  for (const key of Object.keys(stub.answers)) delete stub.answers[key];
});

/** Answers verification.findFirst by identifier. */
function verificationRows(rows: Record<string, { value: string; expiresAt?: Date } | undefined>) {
  stub.answers["verification.findFirst"] = (args) => {
    const where = args.where as { identifier: string };
    return rows[where.identifier] ?? null;
  };
}

describe("recordResetLinkMailed", () => {
  it("records beside a live link, hashed, with the link's expiry, under the owner fence", async () => {
    verificationRows({ "reset-password:tok": { value: "u1", expiresAt: LATER } });
    expect(
      await recordResetLinkMailed({
        token: "tok",
        userId: "u1",
        email: "a@example.test",
        now: NOW,
      }),
    ).toBe(true);
    expect(stub.calls).toEqual([
      "begin",
      LOCK,
      `verification.findFirst ${JSON.stringify({
        where: { identifier: "reset-password:tok", value: "u1", expiresAt: { gt: NOW } },
        select: { expiresAt: true },
      })}`,
      `verification.create ${JSON.stringify({
        data: {
          identifier: mailedId("tok"),
          value: JSON.stringify({ userId: "u1", email: "a@example.test" }),
          expiresAt: LATER,
        },
        select: { id: true },
      })}`,
      "commit",
    ]);
    expect(stub.calls.join("\n")).not.toContain('"reset-password-mailed:tok"');
  });

  it("records nothing for a gone, expired or other user's link", async () => {
    verificationRows({});
    expect(
      await recordResetLinkMailed({
        token: "tok",
        userId: "u1",
        email: "a@example.test",
        now: NOW,
      }),
    ).toBe(false);
    expect(stub.calls.some((call) => call.startsWith("verification.create"))).toBe(false);
  });
});

describe("isResetLinkRedeemable", () => {
  it("lets a mailed link through without the lock, whatever the account's state", async () => {
    verificationRows({
      "reset-password:tok": { value: "u1" },
      [mailedId("tok")]: { value: JSON.stringify({ userId: "u1", email: "a@example.test" }) },
    });
    expect(await isResetLinkRedeemable("tok", NOW)).toBe(true);
    expect(stub.calls).not.toContain(LOCK);
    expect(stub.calls.some((call) => call.startsWith("user.findUnique"))).toBe(false);
  });

  it("leaves an unknown or expired token to Better Auth", async () => {
    verificationRows({});
    expect(await isResetLinkRedeemable("tok", NOW)).toBe(true);
    expect(stub.calls).not.toContain(LOCK);
  });

  it("lets a shown link through only for a pending invite, read under the lock", async () => {
    verificationRows({
      "reset-password:tok": { value: "u1" },
      "admin-invited:u1": { value: "u1" },
    });
    stub.answers["user.findUnique"] = () => pendingState;
    expect(await isResetLinkRedeemable("tok", NOW)).toBe(true);
    const lockAt = stub.calls.indexOf(LOCK);
    const readAt = stub.calls.findIndex((call) => call.startsWith("user.findUnique"));
    expect(lockAt).toBeGreaterThan(0);
    expect(readAt).toBeGreaterThan(lockAt);
    expect(stub.calls.some((call) => call.startsWith("verification.deleteMany"))).toBe(false);
  });

  it.each([
    ["verified", { ...pendingState, emailVerified: true }, true],
    ["signed in", { ...pendingState, sessions: [{ id: "s" }] }, true],
    [
      "another provider linked",
      { ...pendingState, accounts: [{ providerId: "credential" }, { providerId: "oidc" }] },
      true,
    ],
    ["not an admin invite (a public sign-up)", pendingState, false],
  ])("refuses and deletes a shown link when the account is %s", async (_label, state, marked) => {
    verificationRows({
      "reset-password:tok": { value: "u1" },
      ...(marked ? { "admin-invited:u1": { value: "u1" } } : {}),
    });
    stub.answers["user.findUnique"] = () => state;
    expect(await isResetLinkRedeemable("tok", NOW)).toBe(false);
    expect(stub.calls).toContain(
      `verification.deleteMany ${JSON.stringify({ where: { identifier: "reset-password:tok", value: "u1" } })}`,
    );
  });

  it("does not count another user's mailed record", async () => {
    verificationRows({
      "reset-password:tok": { value: "u1" },
      [mailedId("tok")]: { value: JSON.stringify({ userId: "u2", email: "b@example.test" }) },
    });
    stub.answers["user.findUnique"] = () => ({ ...pendingState, emailVerified: true });
    expect(await isResetLinkRedeemable("tok", NOW)).toBe(false);
  });

  it("re-checks the mailed record under the lock (its writer may have held it)", async () => {
    let lookups = 0;
    stub.answers["verification.findFirst"] = (args) => {
      const where = args.where as { identifier: string };
      if (where.identifier === "reset-password:tok") return { value: "u1" };
      if (where.identifier === mailedId("tok")) {
        lookups += 1;
        return lookups > 1 ? { value: JSON.stringify({ userId: "u1", email: "a" }) } : null;
      }
      return null;
    };
    expect(await isResetLinkRedeemable("tok", NOW)).toBe(true);
    expect(stub.calls.some((call) => call.startsWith("user.findUnique"))).toBe(false);
  });
});

describe("admitResetSpend", () => {
  const spend = (activatePrivateInvite = false) =>
    admitResetSpend(stub.client as unknown as Parameters<typeof admitResetSpend>[0], "tok", NOW, {
      activatePrivateInvite,
    });
  const setup = (mailed: string | null, marked = true) => {
    verificationRows({
      "reset-password:tok": { value: "u1" },
      "admin-invited:u1": marked ? { value: "u1" } : undefined,
      ...(mailed === null ? {} : { [mailedId("tok")]: { value: mailed } }),
    });
    stub.answers["user.findUnique"] = () => ({ ...pendingState, email: "A@example.test" });
    stub.answers["verification.deleteMany"] = () => ({ count: 1 });
    stub.answers["user.updateMany"] = () => ({ count: 1 });
  };
  it("stages mailed proof and competing link deletion on the supplied transaction", async () => {
    setup(JSON.stringify({ userId: "u1", email: "A@example.test" }));
    expect(await spend()).toBe(true);
    expect(stub.calls).toContain(LOCK);
    expect(stub.calls).toContain(
      `user.updateMany ${JSON.stringify({ where: { id: "u1", email: "A@example.test" }, data: { emailVerified: true, provedEmail: "a@example.test" } })}`,
    );
    expect(stub.calls.some((x) => x.includes('"not":"reset-password:tok"'))).toBe(true);
    expect(stub.calls).not.toContain("begin");
  });
  it("admits a marked shown invite without proof in SMTP mode", async () => {
    setup(null);
    expect(await spend()).toBe(true);
    expect(stub.calls.some((x) => x.startsWith("user.updateMany"))).toBe(false);
  });
  it.each([
    { ...pendingState, emailVerified: true },
    { ...pendingState, accounts: [{ providerId: "credential" }, { providerId: "other" }] },
    { ...pendingState, sessions: [{ id: "session" }] },
  ])("rejects a shown link after activation", async (state) => {
    setup(null);
    stub.answers["user.findUnique"] = () => ({ ...state, email: "A@example.test" });
    expect(await spend()).toBe(false);
  });
  it("rejects a link that disappears while waiting for the owner fence", async () => {
    setup(null);
    let reads = 0;
    stub.answers["verification.findFirst"] = () => (++reads === 1 ? { value: "u1" } : null);
    expect(await spend()).toBe(false);
    expect(stub.calls.some((x) => x.startsWith("verification.deleteMany"))).toBe(false);
  });
  it("activates a private invite without proving the mailbox", async () => {
    setup(null);
    expect(await spend(true)).toBe(true);
    expect(stub.calls).toContain(
      `user.updateMany ${JSON.stringify({ where: { id: "u1" }, data: { emailVerified: true } })}`,
    );
  });
  it.each([null, "invalid", JSON.stringify({ userId: "u1", email: "other@example.test" })])(
    "rejects unmarked unproved links",
    async (mailed) => {
      setup(mailed, false);
      expect(await spend()).toBe(false);
      expect(
        stub.calls.some(
          (x) => x.startsWith("user.updateMany") || x.startsWith("verification.deleteMany"),
        ),
      ).toBe(false);
    },
  );
});

describe("isInvitePending", () => {
  it("needs the admin-invited mark", () => {
    expect(isInvitePending({ ...pendingState, adminInvited: true })).toBe(true);
    expect(isInvitePending({ ...pendingState, adminInvited: false })).toBe(false);
  });
});

describe("reset tokens of a request", () => {
  it("reads the token of POST /reset-password from the body or the query", () => {
    expect(resetTokenOf({ path: "/reset-password", body: { token: "b" } })).toBe("b");
    expect(resetTokenOf({ path: "/reset-password", body: {}, query: { token: "q" } })).toBe("q");
    expect(resetTokenOf({ path: "/reset-password", body: { token: "" } })).toBeNull();
    expect(resetTokenOf({ path: "/reset-password/tok", body: { token: "b" } })).toBeNull();
  });
});
