/**
 * Cloud spend read model (spend caps, spec §2.7 / §3.13). Read-only: every query here is a plain
 * snapshot read (no lock, no fence), usable inside a fenced spend transaction or on its own.
 *
 * Settled spend comes from `usage_ledger`, which is revisioned per attempt fence
 * `(attemptId, fencingToken)`: a SNAPSHOT revision states the attempt's whole settled cost so
 * far and a DELTA adds to it. An attempt's settled cost is therefore its latest SNAPSHOT's
 * `settledCost` plus the `settledCost` of every DELTA after it (all DELTAs when it has no
 * SNAPSHOT). A plain `SUM("settledCost")` counts every superseded snapshot again.
 *
 * Month attribution: an attempt belongs to the UTC calendar month of its FIRST ledger revision,
 * whole (later corrections included), so a correction never moves cost between months.
 * Share caps attribute by admission month instead (the reservation's window), since the ledger
 * does not name the share.
 *
 * Reserved spend is the liability of cloud attempts still in flight: an ACTIVE `attempt` of kind
 * CLOUD with no ledger revision yet (crash-expired attempts stay reserved until the repair sweep
 * settles them at their liability). Per cap it is the cap's RESERVED reservations.
 */
import { Prisma } from "../prisma/generated/client";

/** Anything that can run a raw query: the client or an interactive transaction. */
export type SpendReader = Pick<Prisma.TransactionClient, "$queryRaw">;

export type MonthWindow = { start: Date; end: Date };

/** The UTC calendar month containing `now` (caps are monthly in UTC). */
export function utcMonthWindow(now: Date = new Date()): MonthWindow {
  if (!Number.isFinite(now.getTime())) throw new RangeError("Invalid spend window date");
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return { start: new Date(Date.UTC(year, month, 1)), end: new Date(Date.UTC(year, month + 1, 1)) };
}

const CURRENCY = /^[A-Z]{3}$/;

function checkedCurrency(currency: string): string {
  if (!CURRENCY.test(currency)) throw new RangeError("Invalid spend currency");
  return currency;
}

function amount(value: unknown): Prisma.Decimal {
  if (value === null || value === undefined) return new Prisma.Decimal(0);
  if (value instanceof Prisma.Decimal) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint")
    return new Prisma.Decimal(value.toString());
  // A driver that hands back another decimal representation still prints its exact value.
  return new Prisma.Decimal(String(value));
}

/**
 * Revision-correct settled cost of the attempts whose ledger rows match `scope` and whose first
 * revision falls in `window`. `scope` filters `usage_ledger l` rows (e.g. by account or payer).
 */
async function settledLedgerSpend(
  db: SpendReader,
  scope: Prisma.Sql,
  currency: string,
  window: MonthWindow,
): Promise<Prisma.Decimal> {
  const rows = await db.$queryRaw<Array<{ total: unknown }>>`
    WITH attempts AS (
      SELECT l."attemptId", l."fencingToken"
        FROM usage_ledger l
       WHERE ${scope}
         AND l."createdAt" >= ${window.start} AND l."createdAt" < ${window.end}
       GROUP BY l."attemptId", l."fencingToken"
    ),
    first_in_window AS (
      SELECT a."attemptId", a."fencingToken"
        FROM attempts a
       WHERE NOT EXISTS (
         SELECT 1 FROM usage_ledger earlier
          WHERE earlier."attemptId" = a."attemptId"
            AND earlier."fencingToken" = a."fencingToken"
            AND earlier."createdAt" < ${window.start})
    ),
    revisions AS (
      SELECT l."attemptId", l."fencingToken", l."revisionSequence", l."revisionKind",
             l."settledCost", l.currency,
             MAX(l."revisionSequence") FILTER (WHERE l."revisionKind" = 'SNAPSHOT')
               OVER (PARTITION BY l."attemptId", l."fencingToken") AS "snapshotSequence"
        FROM usage_ledger l
        JOIN first_in_window f
          ON f."attemptId" = l."attemptId" AND f."fencingToken" = l."fencingToken"
    )
    SELECT COALESCE(SUM(r."settledCost"), 0)::numeric(30, 9) AS total
      FROM revisions r
     WHERE r.currency = ${currency}
       AND r."settledCost" IS NOT NULL
       AND (r."snapshotSequence" IS NULL OR r."revisionSequence" >= r."snapshotSequence")`;
  return amount(rows[0]?.total);
}

/** Liability of the in-flight cloud attempts matching `scope` (filters `attempt a`). */
async function reservedAttemptSpend(
  db: SpendReader,
  scope: Prisma.Sql,
  currency: string,
): Promise<Prisma.Decimal> {
  const rows = await db.$queryRaw<Array<{ total: unknown }>>`
    SELECT COALESCE(SUM(a."liabilitySpend"), 0)::numeric(30, 9) AS total
      FROM attempt a
     WHERE ${scope}
       AND a.kind = 'CLOUD'::"AttemptKind"
       AND a.state = 'ACTIVE'::"AttemptState"
       AND a."liabilityCurrency" = ${currency}
       AND NOT EXISTS (
         SELECT 1 FROM usage_ledger l
          WHERE l."attemptId" = a.id AND l."fencingToken" = a."fencingToken")`;
  return amount(rows[0]?.total);
}

/** This month's settled spend through one provider account (every pool and caller). */
export function providerAccountSettledSpend(
  db: SpendReader,
  input: { providerAccountId: string; currency: string; window?: MonthWindow },
): Promise<Prisma.Decimal> {
  return settledLedgerSpend(
    db,
    Prisma.sql`l."providerAccountId" = ${input.providerAccountId}`,
    checkedCurrency(input.currency),
    input.window ?? utcMonthWindow(),
  );
}

/** This month's settled spend paid by one user (the payer: account owner, or own-key holder). */
export function userSettledSpend(
  db: SpendReader,
  input: { userId: string; currency: string; window?: MonthWindow },
): Promise<Prisma.Decimal> {
  return settledLedgerSpend(
    db,
    Prisma.sql`l."userId" = ${input.userId}`,
    checkedCurrency(input.currency),
    input.window ?? utcMonthWindow(),
  );
}

/** Liability of cloud attempts in flight on one provider account. */
export function providerAccountReservedSpend(
  db: SpendReader,
  input: { providerAccountId: string; currency: string },
): Promise<Prisma.Decimal> {
  return reservedAttemptSpend(
    db,
    Prisma.sql`a."providerAccountId" = ${input.providerAccountId}`,
    checkedCurrency(input.currency),
  );
}

/** Liability of cloud attempts in flight paid by one user. */
export function userReservedSpend(
  db: SpendReader,
  input: { userId: string; currency: string },
): Promise<Prisma.Decimal> {
  return reservedAttemptSpend(
    db,
    Prisma.sql`a."userId" = ${input.userId}`,
    checkedCurrency(input.currency),
  );
}

/**
 * The provider account's spend view (`providers` contract `spend`): settled this month and
 * reserved now, in the cap's currency (USD when uncapped).
 */
export async function providerAccountSpend(
  db: SpendReader,
  input: { providerAccountId: string; currency: string; now?: Date },
): Promise<{ spentThisMonth: Prisma.Decimal; reservedNow: Prisma.Decimal }> {
  const [spentThisMonth, reservedNow] = await Promise.all([
    providerAccountSettledSpend(db, {
      providerAccountId: input.providerAccountId,
      currency: input.currency,
      window: utcMonthWindow(input.now),
    }),
    providerAccountReservedSpend(db, input),
  ]);
  return { spentThisMonth, reservedNow };
}

/**
 * Settled spend this month of the attempts admitted against one cap (by reservation window).
 * Used for share caps, whose subject the ledger does not name.
 */
export async function capSettledSpend(
  db: SpendReader,
  input: { capId: string; currency: string; window?: MonthWindow },
): Promise<Prisma.Decimal> {
  const window = input.window ?? utcMonthWindow();
  const rows = await db.$queryRaw<Array<{ total: unknown }>>`
    WITH attempts AS (
      SELECT DISTINCT r."attemptId", r."fencingToken"
        FROM spend_reservation r
       WHERE r."capId" = ${input.capId} AND r."windowStart" = ${window.start}
    ),
    revisions AS (
      SELECT l."revisionSequence", l."settledCost", l.currency,
             MAX(l."revisionSequence") FILTER (WHERE l."revisionKind" = 'SNAPSHOT')
               OVER (PARTITION BY l."attemptId", l."fencingToken") AS "snapshotSequence"
        FROM usage_ledger l
        JOIN attempts a ON a."attemptId" = l."attemptId" AND a."fencingToken" = l."fencingToken"
    )
    SELECT COALESCE(SUM(r."settledCost"), 0)::numeric(30, 9) AS total
      FROM revisions r
     WHERE r.currency = ${checkedCurrency(input.currency)}
       AND r."settledCost" IS NOT NULL
       AND (r."snapshotSequence" IS NULL OR r."revisionSequence" >= r."snapshotSequence")`;
  return amount(rows[0]?.total);
}

/** Liability held by one cap's open reservations (every window: an open hold is still owed). */
export async function capReservedSpend(
  db: SpendReader,
  input: { capId: string; currency: string },
): Promise<Prisma.Decimal> {
  const rows = await db.$queryRaw<Array<{ total: unknown }>>`
    SELECT COALESCE(SUM(r."reservedValue"), 0)::numeric(30, 9) AS total
      FROM spend_reservation r
     WHERE r."capId" = ${input.capId}
       AND r.state = 'RESERVED'::"ReservationState"
       AND r.currency = ${checkedCurrency(input.currency)}`;
  return amount(rows[0]?.total);
}

/** A share cap's view: spent this month (admission month) and reserved now. */
export async function shareCapSpend(
  db: SpendReader,
  input: { capId: string; currency: string; now?: Date },
): Promise<{ spentThisMonth: Prisma.Decimal; reservedNow: Prisma.Decimal }> {
  const [spentThisMonth, reservedNow] = await Promise.all([
    capSettledSpend(db, { ...input, window: utcMonthWindow(input.now) }),
    capReservedSpend(db, input),
  ]);
  return { spentThisMonth, reservedNow };
}
