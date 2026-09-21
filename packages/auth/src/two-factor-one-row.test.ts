import { type BetterAuthOptions, betterAuth } from "better-auth";
import { createAdapterFactory } from "better-auth/adapters";
import { symmetricDecrypt } from "better-auth/crypto";
import { twoFactor } from "better-auth/plugins";
import { describe, expect, it } from "vitest";

/**
 * Behavioral proof of the TwoFactor one-row-per-user contract: the installed
 * better-auth 1.7.3 two-factor
 * enrollment path (`auth.api.enableTwoFactor`) performs a
 * findOne-by-userId → update-by-id-or-create sequence. Our Prisma
 * `@@unique([userId])` is what makes that sequence safe — a concurrent or
 * repeated enrollment can never produce a second twoFactor row.
 *
 * This drives the REAL plugin logic against a real `betterAuth` instance
 * backed by a minimal in-memory adapter that enforces the same unique
 * constraint the Prisma schema declares (it rejects a second `twoFactor`
 * create for the same userId, like Postgres rejects it with a 23505).
 * No database connection is made.
 */

type Row = Record<string, unknown>;
type WhereClause = {
  field: string;
  value: unknown;
  operator?: string;
  connector?: "AND" | "OR";
};

type OperationLogEntry = {
  op: "create" | "update" | "delete";
  model: string;
  /** where clauses for update/delete (create carries none) */
  where?: Array<{ field: string; value: unknown }>;
};

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
    default:
      return recordValue === expected;
  }
}

function matchesWhere(row: Row, where: WhereClause[]): boolean {
  return where.every((clause) => matchesClause(row, clause));
}

/**
 * In-memory adapter factory (same integration shape the memory/kysely
 * adapters use: `database` is a function of the auth options). Creates go to
 * per-model arrays; the twoFactor model additionally enforces the repo's
 * `@@unique([userId])` by throwing on a duplicate create, exactly like the
 * Prisma client does against Postgres.
 */
function createStubAdapter() {
  const store = new Map<string, Row[]>();
  const operations: OperationLogEntry[] = [];

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
      create: async <T extends Row>({
        model,
        data,
      }: {
        model: string;
        data: T;
        select?: string[];
      }): Promise<T> => {
        operations.push({ op: "create", model });
        if (model === "twoFactor" && table(model).some((row) => row.userId === data.userId)) {
          // Mirrors Prisma P2002 on @@unique([userId]).
          throw new Error(`Unique constraint failed: twoFactor.userId = ${String(data.userId)}`);
        }
        table(model).push({ ...data });
        return data;
      },
      findOne: async <T>({
        model,
        where,
      }: {
        model: string;
        where: WhereClause[];
        select?: string[];
      }): Promise<T | null> => (query(model, where)[0] ?? null) as T | null,
      findMany: async <T>({
        model,
        where,
      }: {
        model: string;
        where?: WhereClause[];
        limit?: number;
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
        operations.push({
          op: "update",
          model,
          where: where.map((clause) => ({ field: clause.field, value: clause.value })),
        });
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
        operations.push({
          op: "delete",
          model,
          where: where.map((clause) => ({ field: clause.field, value: clause.value })),
        });
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
    }),
  });

  return { adapter, store, operations };
}

const SECRET = "test-secret-0123456789-abcdefghijk";

/**
 * RFC 4648 base32 decode (standard alphabet, padding-insensitive) — the
 * inverse of @better-auth/utils' `base32.encode(secret, { padding: false })`
 * that the totpURI secret parameter is built with (otp.mjs generateQRCode),
 * so the URI's secret can be compared against the symmetricDecrypt of the
 * stored column.
 */
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

function buildAuth() {
  const stub = createStubAdapter();
  let wrappedCreate: ((args: { model: string; data: Row }) => Promise<Row>) | undefined;
  const auth = betterAuth({
    secret: SECRET,
    baseURL: "http://localhost:3000",
    emailAndPassword: { enabled: true },
    database: (options: BetterAuthOptions) => {
      // `database` as a function receives the auth options and must return
      // the adapter instance (same integration shape as kyselyAdapter(...)).
      // Capture the wrapped create so the guard test below can drive it.
      const instance = stub.adapter(options);
      wrappedCreate = (args: { model: string; data: Row }) => instance.create(args);
      return instance;
    },
    plugins: [twoFactor()],
  });
  return { auth, stub, getWrappedCreate: () => wrappedCreate };
}

async function signInCookie(
  auth: ReturnType<typeof buildAuth>["auth"],
  email: string,
  password: string,
): Promise<string> {
  const response = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  if (!response.ok) {
    throw new Error(`signInEmail failed: ${response.status}`);
  }
  const sessionCookie = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith("better-auth.session_token="));
  if (!sessionCookie) {
    throw new Error("signInEmail did not set a session cookie");
  }
  return sessionCookie.split(";")[0] ?? "";
}

describe("two-factor enrollment one-row-per-user (behavioral)", () => {
  it("repeated enable keeps one row, updates by id, isolates the selector, and persists the second enrollment's credentials", async () => {
    const { auth, stub, getWrappedCreate } = buildAuth();
    const email = "one-row@example.com";
    const password = "correct-horse-battery-staple";

    // Real sign-up: creates the user and a credential account with a real
    // scrypt password hash through the plugin stack.
    await auth.api.signUpEmail({
      body: { email, password, name: "One Row" },
    });

    const cookie = await signInCookie(auth, email, password);

    // First enrollment: no existing row → create path.
    const first = await auth.api.enableTwoFactor({
      body: { password, method: "totp" },
      headers: { cookie },
    });
    expect(first.method).toBe("totp");
    if (first.method !== "totp") {
      throw new Error(`expected totp enable result, got ${first.method}`);
    }
    expect(typeof first.totpURI).toBe("string");
    expect(first.backupCodes?.length).toBeGreaterThan(0);

    const rowsAfterFirst = stub.store.get("twoFactor") ?? [];
    expect(rowsAfterFirst).toHaveLength(1);
    const row = rowsAfterFirst[0]!;
    expect(row.userId).toBe(
      (stub.store.get("user") ?? []).find((user) => user.email === email)?.id,
    );
    // skipVerificationOnEnable is off in production config, so the fresh row
    // is unverified — which is why a second enable is permitted at all.
    expect(row.verified).toBe(false);

    const createsAfterFirst = stub.operations.filter(
      (entry) => entry.op === "create" && entry.model === "twoFactor",
    );
    expect(createsAfterFirst).toHaveLength(1);

    // Snapshot user 1's stored credentials BEFORE the second enable (the
    // adapter mutates rows in place on update, so the row object itself
    // cannot serve as a "before" record).
    const firstSecret = row.secret;
    const firstBackupCodes = row.backupCodes;
    expect(typeof firstSecret).toBe("string");
    expect(typeof firstBackupCodes).toBe("string");

    // Competing-row isolation setup: a SECOND user's twoFactor row created
    // through the same enforcing adapter. The wrapped create passes through
    // the better-auth adapter input transformation, which retains only
    // plugin-declared fields — and the installed TwoFactor plugin schema
    // omits createdAt/updatedAt — so the timestamps cannot ride along with
    // the create payload. Supply them directly in the stub's underlying
    // store AFTER the create (the stub is ours; this mirrors what Prisma's
    // column defaults do in production, where every row always carries
    // createdAt/updatedAt regardless of what the plugin writes). After
    // user 1's second enable the entire row must be deep-equal to a deep
    // copy snapshotted here, proving the update selector [{id}] cannot
    // leak onto — or corrupt ANY field of — other users' rows.
    const directCreate = getWrappedCreate();
    if (!directCreate) throw new Error("adapter was not instantiated");
    const competingUserId = "competing-user-id";
    await directCreate({
      model: "twoFactor",
      data: {
        userId: competingUserId,
        secret: "competing-user-encrypted-secret",
        backupCodes: "competing-user-encrypted-backup-codes",
        verified: true,
        failedVerificationCount: 0,
        lockedUntil: null,
      },
    });
    const competingBefore = (stub.store.get("twoFactor") ?? []).find(
      (candidate) => candidate.userId === competingUserId,
    );
    if (!competingBefore) throw new Error("competing row was not created");
    competingBefore.createdAt = new Date("2026-01-01T00:00:00.000Z");
    competingBefore.updatedAt = new Date("2026-01-01T00:00:00.000Z");
    // Full field inventory BEFORE cloning: the snapshot claim below is only
    // meaningful if the competing row actually carries the complete column
    // set the Prisma model declares. The wrapped create stripped
    // createdAt/updatedAt (not plugin-declared), which is exactly why they
    // were supplied at the store level above.
    expect(Object.keys(competingBefore).sort()).toEqual(
      [
        "id",
        "userId",
        "secret",
        "backupCodes",
        "verified",
        "failedVerificationCount",
        "lockedUntil",
        "createdAt",
        "updatedAt",
      ].sort(),
    );
    // Deep copy: the adapter mutates rows in place on update, so the row
    // object itself cannot serve as the "before" record.
    const competingSnapshot = structuredClone(competingBefore);

    // Second enrollment for the same user: the plugin must find the existing
    // (still unverified) row and take the update-by-id path.
    const second = await auth.api.enableTwoFactor({
      body: { password, method: "totp" },
      headers: { cookie },
    });
    expect(second.method).toBe("totp");
    if (second.method !== "totp") {
      throw new Error(`expected totp enable result, got ${second.method}`);
    }
    expect(typeof second.totpURI).toBe("string");

    // Exactly ONE twoFactor row exists for user 1 after both attempts, and
    // exactly 2 rows in total (user 1 + the competing user).
    const rowsAfterSecond = stub.store.get("twoFactor") ?? [];
    const userOneRows = rowsAfterSecond.filter((candidate) => candidate.userId === row.userId);
    expect(userOneRows).toHaveLength(1);
    expect(rowsAfterSecond).toHaveLength(2);

    // The plugin builds its response from local variables (installed
    // two-factor/index.mjs: secret/backupCodes are generated, then
    // encrypted, then written), so a passing response does NOT by itself
    // prove the update persisted. Link the STORED secret to the response's
    // secret via symmetricDecrypt: the row stores the symmetricEncrypt-
    // encrypted secret (with the single string `secret: SECRET` the test
    // constructs betterAuth with, secretConfig IS that string, so
    // symmetricDecrypt with it inverts the stored value), while the totpURI
    // embeds base32(raw secret) — decode the URI parameter to compare.
    const rowAfterSecond = userOneRows[0]!;
    const raw2 = new URL(second.totpURI).searchParams.get("secret");
    expect(raw2).toBeTruthy();
    const raw2Decoded = new TextDecoder().decode(decodeBase32(raw2!));
    const storedSecretAfterSecond = rowAfterSecond.secret;
    if (typeof storedSecretAfterSecond !== "string") {
      throw new Error("stored twoFactor secret is not a string");
    }
    expect(await symmetricDecrypt({ key: SECRET, data: storedSecretAfterSecond })).toBe(
      raw2Decoded,
    );
    // The second enrollment actually replaced the stored credentials (not a
    // replay of the first enrollment's values) and they are encrypted at
    // rest (the stored value is never the decoded raw secret).
    expect(rowAfterSecond.secret).not.toBe(firstSecret);
    expect(rowAfterSecond.backupCodes).not.toBe(firstBackupCodes);
    expect(rowAfterSecond.secret).not.toBe(raw2Decoded);

    // Backup-code linkage: the two-factor plugin defaults
    // storeBackupCodes to "encrypted", and encodeBackupCodes (installed
    // two-factor/backup-codes/index.mjs) JSON-stringifies the codes array
    // then symmetricEncrypts it with the SAME secretConfig-derived key as
    // the secret. So the stored column is decryptable with
    // symmetricDecrypt({key: SECRET, ...}); decrypt it, parse the JSON
    // array, and assert the set equals the response's plaintext codes
    // (order-insensitive) — proving the update persisted the second
    // enrollment's backup codes, not just rotated the ciphertext.
    expect(second.backupCodes?.length).toBeGreaterThan(0);
    const storedBackupCodesAfterSecond = rowAfterSecond.backupCodes;
    if (typeof storedBackupCodesAfterSecond !== "string") {
      throw new Error("stored twoFactor backupCodes is not a string");
    }
    const decryptedBackupCodes: unknown = JSON.parse(
      await symmetricDecrypt({ key: SECRET, data: storedBackupCodesAfterSecond }),
    );
    if (!Array.isArray(decryptedBackupCodes)) {
      throw new Error("decrypted backup codes are not a JSON array");
    }
    const storedCodeList = decryptedBackupCodes.filter(
      (code): code is string => typeof code === "string",
    );
    expect(storedCodeList).toHaveLength(decryptedBackupCodes.length);
    expect([...storedCodeList].sort()).toEqual([...(second.backupCodes ?? [])].sort());

    // Competing-row isolation: the second user's row is fully intact —
    // deep-equal to the pre-second-enable snapshot across EVERY field
    // (id/secret/backupCodes/verified/failedVerificationCount/lockedUntil/
    // createdAt/updatedAt), not just the credential columns.
    const competingAfter = rowsAfterSecond.find(
      (candidate) => candidate.userId === competingUserId,
    );
    if (!competingAfter) throw new Error("competing row disappeared after the second enable");
    expect(competingAfter).toEqual(competingSnapshot);

    // And the second attempt took update-by-id, not create: had it tried to
    // create, the stub's @@unique([userId]) enforcement would have thrown.
    // (The 2 creates are user 1's first enable + the competing user's direct
    // row created above through the same adapter.)
    const twoFactorOps = stub.operations.filter((entry) => entry.model === "twoFactor");
    const creates = twoFactorOps.filter((entry) => entry.op === "create");
    const updates = twoFactorOps.filter((entry) => entry.op === "update");
    expect(creates).toHaveLength(2);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.where).toEqual([{ field: "id", value: row.id }]);
  });

  it("the stub rejects a second twoFactor create for the same userId (schema enforcement is load-bearing)", async () => {
    // Direct proof that the unique constraint the Prisma schema declares is
    // what the upstream read/update/create pattern relies on: bypassing the
    // plugin's findOne and creating a duplicate is rejected the same way
    // Postgres rejects it with a 23505 against @@unique([userId]).
    const { auth, getWrappedCreate } = buildAuth();
    void auth;
    const create = getWrappedCreate();
    if (!create) throw new Error("adapter was not instantiated");
    const first = await create({
      model: "twoFactor",
      data: { userId: "user-1", secret: "s1", backupCodes: "b1", verified: false },
    });
    expect(first.userId).toBe("user-1");
    await expect(
      create({
        model: "twoFactor",
        data: { userId: "user-1", secret: "s2", backupCodes: "b2", verified: false },
      }),
    ).rejects.toThrow(/Unique constraint failed: twoFactor\.userId/);
    // A different user is not affected.
    const other = await create({
      model: "twoFactor",
      data: { userId: "user-2", secret: "s3", backupCodes: "b3", verified: false },
    });
    expect(other.userId).toBe("user-2");
  });
});
