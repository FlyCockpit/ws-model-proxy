import { createHmac } from "node:crypto";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { createAdapterFactory } from "better-auth/adapters";
import { twoFactor } from "better-auth/plugins";
import { describe, expect, it, vi } from "vitest";

/**
 * Behavioral lockout tests for the installed better-auth@1.7.3 two-factor
 * plugin (MCP plan Phase 9 / gap-analysis Section 1: the schema pins
 * failedVerificationCount/lockedUntil structurally, but no test drove the
 * behavior). Pins the installed verify-two-factor.mjs contract against a
 * real `betterAuth` instance over an in-memory adapter (the
 * two-factor-one-row.test.ts pattern — no database connection):
 *
 * - consecutive failed SIGN-IN TOTP verifications increment
 *   failedVerificationCount and lock the row (lockedUntil) at the plugin's
 *   default maxFailedAttempts (10) for the default 900s window;
 * - while locked, even a CORRECT code is rejected 429
 *   ACCOUNT_TEMPORARILY_LOCKED (fail closed);
 * - an expired lock is lazily cleared THROUGH THE INVALID-CODE PATH
 *   (wrong code after expiry → 401 with the counter reset to 1, not 11 —
 *   the lazy clear itself is pinned, not masked by the success reset);
 * - a successful verification resets the failure budget (consecutive
 *   failures only).
 *
 * The lockout helpers run ONLY on the sign-in path (isSignIn — no session;
 * the user is identified by the pending 2FA challenge cookie). Each sign-in
 * challenge additionally permits 5 verification attempts before
 * TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE, so the lockout drive below re-signs-in
 * (fresh challenge) for every failed attempt — exactly what a persistent
 * attacker does, and exactly what the ACCOUNT-level lockout must survive.
 */

type Row = Record<string, unknown>;
type WhereClause = {
  field: string;
  value: unknown;
  operator?: string;
  connector?: "AND" | "OR";
};

/**
 * Ordered comparison with the SAME semantics the real production Prisma
 * adapter has: better-auth's prisma adapter passes `gte`/`lte` clauses
 * straight through as Prisma `{ lte: value }` / `{ gte: value }` filters
 * (@better-auth/prisma-adapter dist index.mjs:94-100,153), and Prisma
 * compares DateTime columns against Date values natively. The plugin's
 * lazy lock-expiry clear filters on `lockedUntil lte new Date(...)`
 * (verify-two-factor.mjs:135-149) — a Date-vs-Date comparison — so a
 * numbers-only `lte` would make that update silently match NOTHING and
 * false-green the expiry coverage.
 */
function compareOrdered(a: unknown, b: unknown): number | null {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  return null;
}

function matchesClause(row: Row, clause: WhereClause): boolean {
  const recordValue = row[clause.field];
  const expected = clause.value;
  switch (clause.operator) {
    case "ne":
      return recordValue !== expected;
    case "in":
      return Array.isArray(expected) && expected.includes(recordValue);
    case "not_in":
      return Array.isArray(expected) && !expected.includes(recordValue);
    case "gte": {
      const order = compareOrdered(recordValue, expected);
      return order !== null && order >= 0;
    }
    case "lte": {
      const order = compareOrdered(recordValue, expected);
      return order !== null && order <= 0;
    }
    default:
      return recordValue === expected;
  }
}

function matchesWhere(row: Row, where: WhereClause[]): boolean {
  return where.every((clause) => matchesClause(row, clause));
}

function createStubAdapter() {
  const store = new Map<string, Row[]>();
  const table = (model: string): Row[] => {
    const existing = store.get(model);
    if (existing) return existing;
    const created: Row[] = [];
    store.set(model, created);
    return created;
  };
  const query = (model: string, where: WhereClause[]): Row[] =>
    table(model).filter((row) => matchesWhere(row, where));

  const adapter = createAdapterFactory({
    config: {
      adapterId: "stub-inmemory",
      adapterName: "Stub In-Memory Adapter",
      usePlural: false,
      supportsArrays: true,
    },
    adapter: () => ({
      create: async <T extends Row>({ model, data }: { model: string; data: T }): Promise<T> => {
        table(model).push({ ...data });
        return data;
      },
      findOne: async <T>({
        model,
        where,
      }: {
        model: string;
        where: WhereClause[];
      }): Promise<T | null> => (query(model, where)[0] ?? null) as T | null,
      findMany: async <T>({
        model,
        where,
      }: {
        model: string;
        where?: WhereClause[];
      }): Promise<T[]> => query(model, where ?? []) as T[],
      count: async ({ model, where }: { model: string; where?: WhereClause[] }): Promise<number> =>
        query(model, where ?? []).length,
      update: async <T>({
        model,
        where,
        update,
      }: {
        model: string;
        where: WhereClause[];
        update: T;
      }): Promise<T | null> => {
        const rows = query(model, where);
        for (const row of rows) Object.assign(row, update);
        return (rows[0] ?? null) as T | null;
      },
      updateMany: async ({
        model,
        where,
        update,
      }: {
        model: string;
        where: WhereClause[];
        update: Row;
      }): Promise<number> => {
        const rows = query(model, where);
        for (const row of rows) Object.assign(row, update);
        return rows.length;
      },
      delete: async ({ model, where }: { model: string; where: WhereClause[] }) => {
        const rows = new Set(query(model, where));
        store.set(
          model,
          table(model).filter((row) => !rows.has(row)),
        );
      },
      deleteMany: async ({ model, where }: { model: string; where: WhereClause[] }) => {
        const rows = new Set(query(model, where));
        store.set(
          model,
          table(model).filter((row) => !rows.has(row)),
        );
        return rows.size;
      },
      incrementOne: async <T>({
        model,
        where,
        increment,
        set,
      }: {
        model: string;
        where: WhereClause[];
        increment: Record<string, number>;
        set?: Record<string, unknown>;
      }): Promise<T | null> => {
        // Mirrors Prisma's atomic updateMany-style increment + set.
        const rows = query(model, where);
        for (const row of rows) {
          for (const [field, by] of Object.entries(increment)) {
            const current = typeof row[field] === "number" ? row[field] : 0;
            row[field] = current + by;
          }
          if (set) Object.assign(row, set);
        }
        return (rows[0] ?? null) as T | null;
      },
    }),
  });

  return { adapter, store };
}

const SECRET = "lockout-test-secret-0123456789-abcdefghij";

/** RFC 4648 base32 decode (the inverse of the URI secret encoding). */
function decodeBase32(value: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let buffer = 0;
  let shift = 0;
  const bytes: number[] = [];
  for (const char of value.replace(/=+$/, "")) {
    const index = alphabet.indexOf(char);
    if (index === -1) throw new Error(`invalid base32 character: ${char}`);
    buffer = (buffer << 5) | index;
    shift += 5;
    if (shift >= 8) {
      shift -= 8;
      bytes.push((buffer >> shift) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

/** RFC 6238 TOTP (HMAC-SHA1, 30 s period, 6 digits) — the plugin defaults. */
function totpCode(secretBytes: Uint8Array, atMs = Date.now()): string {
  const counter = Math.floor(atMs / 30_000);
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buffer.writeUInt32BE(counter % 2 ** 32, 4);
  const digest = createHmac("sha1", Buffer.from(secretBytes)).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, "0");
}

/**
 * A DETERMINISTICALLY wrong TOTP for the frozen instant. The installed
 * verifier (@better-auth/utils dist otp.mjs:42-57) defaults to
 * `window = 1` — it ACCEPTS the previous, current, AND next step codes, and
 * better-auth's totp/index.mjs:188-194 does not override that window. A code
 * that merely differs from the current step (the round-2 `(n+1) % 1e6`
 * neighbor) can coincide with an adjacent step's code and be accepted
 * (renewal-review counterexample at this suite's frozen instant). So: build
 * the FULL accepted window at `atMs` and walk upward from the current code
 * until landing outside it. At most 3 of 1e6 codes are excluded, so the walk
 * terminates within a few increments and the result is guaranteed wrong for
 * the entire accepted window — never a lucky accept, never flaky.
 */
function wrongTotpCode(secretBytes: Uint8Array, atMs: number): string {
  const format = (n: number) => String(n).padStart(6, "0");
  const accepted = new Set(
    [-30_000, 0, 30_000].map((delta) => totpCode(secretBytes, atMs + delta)),
  );
  let candidate = (Number(totpCode(secretBytes, atMs)) + 1) % 1_000_000;
  while (accepted.has(format(candidate))) {
    candidate = (candidate + 1) % 1_000_000;
  }
  return format(candidate);
}

function buildAuth() {
  const stub = createStubAdapter();
  const auth = betterAuth({
    secret: SECRET,
    baseURL: "http://localhost:3000",
    emailAndPassword: { enabled: true },
    database: (options: BetterAuthOptions) => stub.adapter(options),
    plugins: [twoFactor({ issuer: "WS Model Proxy" })],
  });
  return { auth, stub };
}

interface EnrolledUser {
  auth: ReturnType<typeof buildAuth>["auth"];
  stub: ReturnType<typeof buildAuth>["stub"];
  secretBytes: Uint8Array;
}

/** signUp → signIn → enable → session-verify (marks the row verified). */
async function enrollVerifiedUser(email: string): Promise<EnrolledUser> {
  const { auth, stub } = buildAuth();
  const password = "lockout-test-password-123";
  await auth.api.signUpEmail({ body: { email, password, name: "Lockout" } });

  const signIn = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  expect(signIn.status).toBe(200);
  const cookie = signIn.headers
    .getSetCookie()
    .map((v) => v.split(";")[0])
    .join("; ");

  const enable = await auth.api.enableTwoFactor({
    body: { password, method: "totp" },
    headers: { cookie },
  });
  if (enable.method !== "totp") throw new Error("expected totp enrollment");
  const rawSecret = new URL(enable.totpURI).searchParams.get("secret");
  if (!rawSecret) throw new Error("totpURI carried no secret");
  const secretBytes = decodeBase32(rawSecret);

  // Session-path verification (isSignIn false — no lockout involvement)
  // marks the row verified and the user twoFactorEnabled.
  const verify = await auth.api.verifyTOTP({
    body: { code: totpCode(secretBytes) },
    headers: { cookie },
    asResponse: true,
  });
  expect(verify.status).toBe(200);
  return { auth, stub, secretBytes };
}

/** signInEmail for a 2FA-enabled user → the pending challenge cookie. */
async function signInForTwoFactor(auth: EnrolledUser["auth"], email: string): Promise<string> {
  const res = await auth.api.signInEmail({
    body: { email, password: "lockout-test-password-123" },
    asResponse: true,
  });
  expect(res.status).toBe(200);
  const challenge = res.headers
    .getSetCookie()
    .flatMap((v) => {
      const pair = v.split(";")[0];
      return pair === undefined ? [] : [pair];
    })
    .find((v): v is string => v.startsWith("better-auth.two_factor="));
  if (!challenge) throw new Error("signInEmail did not set a 2FA challenge cookie");
  return challenge;
}

async function verifySignInCode(
  auth: EnrolledUser["auth"],
  challengeCookie: string,
  code: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await auth.api.verifyTOTP({
    body: { code },
    headers: { cookie: challengeCookie },
    asResponse: true,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function twoFactorRow(stub: EnrolledUser["stub"]): Row {
  const rows = stub.store.get("twoFactor") ?? [];
  if (rows.length !== 1) throw new Error(`expected one twoFactor row, got ${rows.length}`);
  return rows[0]!;
}

/**
 * Frozen instant for every lockout drive: a deterministic TOTP time step
 * (the wrong-code derivation below is relative to the CURRENT valid code,
 * so the bucket must not move mid-drive) and an exact pin of the 900 000 ms
 * lock window (the plugin stamps `new Date(now + durationMs)` —
 * verify-two-factor.mjs:186-203 — so under a frozen clock the delta is
 * EXACTLY the configured duration; any provider change to the default
 * 900 s / 10 attempts fails these assertions).
 */
const FROZEN_NOW = Date.parse("2025-06-01T12:00:00.000Z");

describe("two-factor account lockout behavior (installed 1.7.3 plugin, in-memory adapter)", () => {
  it("failed sign-in verifications count up, lock at the default 10 attempts / 900 s window, and reject a CORRECT code while locked", async () => {
    const email = "lockout@example.test";
    const { auth, stub, secretBytes } = await enrollVerifiedUser(email);

    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
    try {
      const wrongCode = wrongTotpCode(secretBytes, FROZEN_NOW);
      // Pin the helper's guarantee: the code is outside the ENTIRE accepted
      // window (±1 step at window = 1), not merely ≠ the current code.
      for (const delta of [-30_000, 0, 30_000]) {
        expect(wrongCode).not.toBe(totpCode(secretBytes, FROZEN_NOW + delta));
      }

      // 9 wrong codes: counter climbs, no lock yet (re-sign-in per attempt —
      // each challenge allows only 5 verification attempts).
      for (let attempt = 0; attempt < 9; attempt++) {
        const challenge = await signInForTwoFactor(auth, email);
        const { status } = await verifySignInCode(auth, challenge, wrongCode);
        expect(status, `attempt ${attempt}`).toBe(401); // invalid code, not yet locked
        expect(twoFactorRow(stub).failedVerificationCount).toBe(attempt + 1);
        expect(twoFactorRow(stub).lockedUntil ?? null).toBeNull();
      }

      // 10th consecutive failure spends the default budget of 10:
      // lockedUntil = frozenNow + EXACTLY 900 000 ms (default 900 s window).
      const tenth = await signInForTwoFactor(auth, email);
      const { status } = await verifySignInCode(auth, tenth, wrongCode);
      expect(status).toBe(401);
      const row = twoFactorRow(stub);
      expect(row.failedVerificationCount).toBe(10);
      const lockedUntil = row.lockedUntil;
      expect(lockedUntil).toBeInstanceOf(Date);
      expect((lockedUntil as Date).getTime() - FROZEN_NOW).toBe(900_000);

      // Fail closed: a fresh challenge + the CORRECT code is still rejected.
      const lockedChallenge = await signInForTwoFactor(auth, email);
      const locked = await verifySignInCode(auth, lockedChallenge, totpCode(secretBytes));
      expect(locked.status).toBe(429);
      expect(locked.body).toMatchObject({ code: "ACCOUNT_TEMPORARILY_LOCKED" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("an expired lock is lazily cleared THROUGH THE INVALID-CODE PATH: a wrong code after expiry fails 401 but resets the counter to 1 (not 11)", async () => {
    const email = "expired-lock@example.test";
    const { auth, stub, secretBytes } = await enrollVerifiedUser(email);

    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
    try {
      const wrongCode = wrongTotpCode(secretBytes, FROZEN_NOW);

      // Spend the budget.
      for (let attempt = 0; attempt < 10; attempt++) {
        const challenge = await signInForTwoFactor(auth, email);
        await verifySignInCode(auth, challenge, wrongCode);
      }
      const row = twoFactorRow(stub);
      expect(row.lockedUntil).toBeInstanceOf(Date);

      // Expire the lock directly in the store (the stub is ours — this is
      // what waiting 900 s would produce).
      row.lockedUntil = new Date(FROZEN_NOW - 1_000);

      // WRONG code: the installed flow (totp/index.mjs:184-204) runs
      // assertTwoFactorNotLocked BEFORE code validation. Seeing the expired
      // lock, it issues the lazy clear — incrementOne where
      // id = row AND lockedUntil <= now, set {failedVerificationCount: 0,
      // lockedUntil: null} (verify-two-factor.mjs:135-149) — and only THEN
      // rejects the code, after which recordTwoFactorFailure increments the
      // fresh counter to 1. This pins THE TRANSITION ITSELF: if the lazy
      // clear's Date `lte` comparison fails to match the row (the round-1
      // false positive — a numbers-only mock `lte`), the counter survives at
      // 10, the wrong code increments it to 11, and this assertion FAILS.
      const challenge = await signInForTwoFactor(auth, email);
      const wrongAfterExpiry = await verifySignInCode(auth, challenge, wrongCode);
      expect(wrongAfterExpiry.status).toBe(401); // still an invalid code...
      const after = twoFactorRow(stub);
      expect(after.failedVerificationCount).toBe(1); // ...but the budget restarted (11 = broken lazy clear)
      expect(after.lockedUntil ?? null).toBeNull(); // lock cleared, not re-armed

      // Verification PROCEEDS after expiry: the next (correct) code signs in
      // and the success path leaves the counter at 0.
      const freshChallenge = await signInForTwoFactor(auth, email);
      const verified = await verifySignInCode(auth, freshChallenge, totpCode(secretBytes));
      expect(verified.status).toBe(200);
      const final = twoFactorRow(stub);
      expect(final.failedVerificationCount).toBe(0);
      expect(final.lockedUntil ?? null).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a successful verification RESETS the failure budget (consecutive failures only)", async () => {
    const email = "reset@example.test";
    const { auth, stub, secretBytes } = await enrollVerifiedUser(email);

    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
    try {
      const wrongCode = wrongTotpCode(secretBytes, FROZEN_NOW);

      // 3 failures, then a successful verification with a fresh challenge.
      for (let attempt = 0; attempt < 3; attempt++) {
        const challenge = await signInForTwoFactor(auth, email);
        await verifySignInCode(auth, challenge, wrongCode);
      }
      expect(twoFactorRow(stub).failedVerificationCount).toBe(3);

      const challenge = await signInForTwoFactor(auth, email);
      const verified = await verifySignInCode(auth, challenge, totpCode(secretBytes));
      expect(verified.status).toBe(200);
      expect(twoFactorRow(stub).failedVerificationCount).toBe(0);
      expect(twoFactorRow(stub).lockedUntil ?? null).toBeNull();

      // The budget genuinely restarted: 3 more failures do NOT lock (a
      // cumulative counter would be at 6 — still unlocked — so push past the
      // point where a NON-reset counter would have locked at attempt 7/8).
      for (let attempt = 0; attempt < 6; attempt++) {
        const c = await signInForTwoFactor(auth, email);
        const { status } = await verifySignInCode(auth, c, wrongCode);
        expect(status, `post-reset attempt ${attempt}`).toBe(401);
      }
      expect(twoFactorRow(stub).failedVerificationCount).toBe(6);
      expect(twoFactorRow(stub).lockedUntil ?? null).toBeNull();

      // And 4 more (10 consecutive since the reset) DO lock.
      for (let attempt = 0; attempt < 4; attempt++) {
        const c = await signInForTwoFactor(auth, email);
        await verifySignInCode(auth, c, wrongCode);
      }
      expect(twoFactorRow(stub).failedVerificationCount).toBe(10);
      expect(twoFactorRow(stub).lockedUntil).toBeInstanceOf(Date);
    } finally {
      vi.useRealTimers();
    }
  });
});
