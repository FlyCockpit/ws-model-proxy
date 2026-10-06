import { Prisma } from "@ws-model-proxy/db";
import {
  capReservedSpend,
  capSettledSpend,
  providerAccountReservedSpend,
  providerAccountSettledSpend,
  providerAccountSpend,
  type SpendReader,
  shareCapSpend,
  userSettledSpend,
  utcMonthWindow,
} from "@ws-model-proxy/db/spend";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";
  process.env.BETTER_AUTH_SECRET ??= "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.SIGNUP_ENABLED ??= "true";
});

/** A reader that records each rendered statement and answers with `totals` in order. */
function recordingReader(totals: unknown[]) {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  const reader: SpendReader = {
    $queryRaw: ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = Prisma.sql(strings, ...values);
      statements.push({ text: sql.text.replace(/\s+/g, " "), values: sql.values });
      const total = totals.shift();
      return Promise.resolve(total === undefined ? [] : [{ total }]);
    }) as SpendReader["$queryRaw"],
  };
  return { reader, statements };
}

describe("spend ledger read model", () => {
  it("windows on the UTC calendar month, December included", () => {
    expect(utcMonthWindow(new Date("2026-10-31T23:59:59.999Z"))).toEqual({
      start: new Date("2026-10-01T00:00:00.000Z"),
      end: new Date("2026-11-01T00:00:00.000Z"),
    });
    expect(utcMonthWindow(new Date("2026-12-15T12:00:00Z"))).toEqual({
      start: new Date("2026-12-01T00:00:00.000Z"),
      end: new Date("2027-01-01T00:00:00.000Z"),
    });
    expect(() => utcMonthWindow(new Date(Number.NaN))).toThrow(RangeError);
  });

  it("sums from the latest SNAPSHOT on per attempt fence, never a plain sum", async () => {
    const { reader, statements } = recordingReader(["5.55"]);
    const window = utcMonthWindow(new Date("2026-10-15T00:00:00Z"));
    const total = await providerAccountSettledSpend(reader, {
      providerAccountId: "account",
      currency: "USD",
      window,
    });
    expect(total.toString()).toBe("5.55");
    const [statement] = statements;
    // Revisions are partitioned per (attemptId, fencingToken) and only the latest snapshot and
    // the deltas after it count.
    expect(statement?.text).toContain(
      `MAX(l."revisionSequence") FILTER (WHERE l."revisionKind" = 'SNAPSHOT') OVER (PARTITION BY l."attemptId", l."fencingToken")`,
    );
    expect(statement?.text).toContain(
      `(r."snapshotSequence" IS NULL OR r."revisionSequence" >= r."snapshotSequence")`,
    );
    // An attempt with a revision before the window belongs to an earlier month, whole.
    expect(statement?.text).toContain(`earlier."createdAt" <`);
    expect(statement?.values).toEqual(["account", window.start, window.end, window.start, "USD"]);
  });

  it("scopes the payer variant by the ledger's userId", async () => {
    const { reader, statements } = recordingReader([null]);
    const total = await userSettledSpend(reader, { userId: "payer", currency: "EUR" });
    expect(total.toString()).toBe("0");
    expect(statements[0]?.text).toContain(`l."userId" =`);
    expect(statements[0]?.values[0]).toBe("payer");
  });

  it("reserves only in-flight cloud attempts that have no ledger revision", async () => {
    const { reader, statements } = recordingReader([new Prisma.Decimal("2.5")]);
    const total = await providerAccountReservedSpend(reader, {
      providerAccountId: "account",
      currency: "USD",
    });
    expect(total.toString()).toBe("2.5");
    expect(statements[0]?.text).toContain(`a.kind = 'CLOUD'::"AttemptKind"`);
    expect(statements[0]?.text).toContain(`a.state = 'ACTIVE'::"AttemptState"`);
    expect(statements[0]?.text).toContain("NOT EXISTS ( SELECT 1 FROM usage_ledger l");
  });

  it("answers the provider spend view as settled this month plus reserved now", async () => {
    const { reader } = recordingReader(["1.25", "0.5"]);
    await expect(
      providerAccountSpend(reader, {
        providerAccountId: "account",
        currency: "USD",
        now: new Date("2026-10-06T00:00:00Z"),
      }),
    ).resolves.toEqual({
      spentThisMonth: new Prisma.Decimal("1.25"),
      reservedNow: new Prisma.Decimal("0.5"),
    });
  });

  it("attributes cap spend by the reservation window and holds open reservations", async () => {
    const { reader, statements } = recordingReader(["2.05", "0.7"]);
    const now = new Date("2026-10-06T00:00:00Z");
    await expect(shareCapSpend(reader, { capId: "cap", currency: "USD", now })).resolves.toEqual({
      spentThisMonth: new Prisma.Decimal("2.05"),
      reservedNow: new Prisma.Decimal("0.7"),
    });
    expect(statements[0]?.text).toContain(`r."windowStart" =`);
    expect(statements[0]?.values).toEqual(["cap", utcMonthWindow(now).start, "USD"]);
    expect(statements[1]?.text).toContain(`r.state = 'RESERVED'::"ReservationState"`);
  });

  it("refuses a malformed currency before querying", async () => {
    const { reader, statements } = recordingReader([]);
    await expect(capReservedSpend(reader, { capId: "cap", currency: "usd" })).rejects.toThrow(
      RangeError,
    );
    await expect(capSettledSpend(reader, { capId: "cap", currency: "US" })).rejects.toThrow(
      RangeError,
    );
    expect(statements).toEqual([]);
  });
});
