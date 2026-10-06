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
 *
 * Reserved spend is the liability of cloud attempts still in flight: an ACTIVE `attempt` of kind
 * CLOUD with no ledger revision yet (crash-expired attempts stay ACTIVE, and reserved, until the
 * repair sweep settles them at their liability). Scopes: the provider account, the payer, and
 * the share (owner-paid share traffic carries `shareId` on its attempt and ledger rows).
 *
 * Invariants the writer (apps/server provider-budget.ts) keeps so nothing is under-counted:
 * - a CLOUD attempt leaves ACTIVE only in the transaction that writes its first ledger revision
 *   (relay telemetry recovery repairs LOCAL attempts only);
 * - a capped attempt always carries a liability in the cap's currency, and each of its ledger
 *   revisions carries a `settledCost` in that currency (the liability itself while the real cost
 *   is unknown);
 * - cap enforcement reads settled and reserved in ONE statement ({@link providerAccountSpend},
 *   {@link shareSpend}): under READ COMMITTED two statements could each miss an attempt whose
 *   settlement commits between them.
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
 * The `revisions` CTE chain: the ledger revisions of the attempts whose ledger rows match
 * `scope` and whose first revision falls in `window`, each with its attempt's latest SNAPSHOT
 * sequence. `scope` filters `usage_ledger l` rows (e.g. by account, payer or share).
 */
function revisionsCte(scope: Prisma.Sql, window: MonthWindow): Prisma.Sql {
  return Prisma.sql`WITH attempts AS (
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
      SELECT l."shareId", l."revisionSequence", l."settledCost", l.currency,
             MAX(l."revisionSequence") FILTER (WHERE l."revisionKind" = 'SNAPSHOT')
               OVER (PARTITION BY l."attemptId", l."fencingToken") AS "snapshotSequence"
        FROM usage_ledger l
        JOIN first_in_window f
          ON f."attemptId" = l."attemptId" AND f."fencingToken" = l."fencingToken"
    )`;
}

/** The revisions that count toward an attempt's settled total (its latest SNAPSHOT onward). */
const COUNTED_REVISION = Prisma.sql`r."settledCost" IS NOT NULL
       AND (r."snapshotSequence" IS NULL OR r."revisionSequence" >= r."snapshotSequence")`;

/** In-flight cloud attempts: ACTIVE, with no ledger revision yet (`attempt a`). */
const IN_FLIGHT_ATTEMPT = Prisma.sql`a.kind = 'CLOUD'::"AttemptKind"
       AND a.state = 'ACTIVE'::"AttemptState"
       AND NOT EXISTS (
         SELECT 1 FROM usage_ledger l
          WHERE l."attemptId" = a.id AND l."fencingToken" = a."fencingToken")`;

/** Revision-correct settled cost (a scalar subquery) of `scope`'s attempts in `window`. */
function settledLedgerSql(scope: Prisma.Sql, currency: string, window: MonthWindow): Prisma.Sql {
  return Prisma.sql`(
    ${revisionsCte(scope, window)}
    SELECT COALESCE(SUM(r."settledCost"), 0)::numeric(30, 9)
      FROM revisions r
     WHERE r.currency = ${currency}
       AND ${COUNTED_REVISION}
  )`;
}

/** Liability (a scalar subquery) of the in-flight cloud attempts matching `scope` (`attempt a`). */
function reservedAttemptSql(scope: Prisma.Sql, currency: string): Prisma.Sql {
  return Prisma.sql`(
    SELECT COALESCE(SUM(a."liabilitySpend"), 0)::numeric(30, 9)
      FROM attempt a
     WHERE ${scope}
       AND a."liabilityCurrency" = ${currency}
       AND ${IN_FLIGHT_ATTEMPT}
  )`;
}

/**
 * Every currency with settled spend this month or a reservation now in `ledgerScope` /
 * `attemptScope` (the same subject), sorted. One statement, so both come from one snapshot.
 */
async function spendCurrencies(
  db: SpendReader,
  ledgerScope: Prisma.Sql,
  attemptScope: Prisma.Sql,
  window: MonthWindow,
): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ currency: string }>>`
    ${revisionsCte(ledgerScope, window)},
    settled AS (
      SELECT r.currency FROM revisions r
       WHERE r.currency IS NOT NULL AND ${COUNTED_REVISION}
       GROUP BY r.currency
      HAVING SUM(r."settledCost") > 0
    ),
    reserved AS (
      SELECT a."liabilityCurrency" AS currency FROM attempt a
       WHERE ${attemptScope} AND a."liabilityCurrency" IS NOT NULL AND ${IN_FLIGHT_ATTEMPT}
       GROUP BY a."liabilityCurrency"
      HAVING SUM(a."liabilitySpend") > 0
    )
    SELECT currency FROM settled UNION SELECT currency FROM reserved ORDER BY currency`;
  return rows.map((row) => row.currency);
}

async function scalar(db: SpendReader, value: Prisma.Sql): Promise<Prisma.Decimal> {
  const rows = await db.$queryRaw<Array<{ total: unknown }>>`SELECT ${value} AS total`;
  return amount(rows[0]?.total);
}

/** Settled and reserved in ONE statement, so both come from the same snapshot. */
async function usagePair(
  db: SpendReader,
  settled: Prisma.Sql,
  reserved: Prisma.Sql,
): Promise<SpendUsage> {
  const rows = await db.$queryRaw<Array<{ settled: unknown; reserved: unknown }>>`
    SELECT ${settled} AS settled, ${reserved} AS reserved`;
  return { spentThisMonth: amount(rows[0]?.settled), reservedNow: amount(rows[0]?.reserved) };
}

/** Settled this month and reserved now (the contract's `spend` view, and a cap's consumption). */
export type SpendUsage = { spentThisMonth: Prisma.Decimal; reservedNow: Prisma.Decimal };

/** This month's settled spend through one provider account (every pool and caller). */
export async function providerAccountSettledSpend(
  db: SpendReader,
  input: { providerAccountId: string; currency: string; window?: MonthWindow },
): Promise<Prisma.Decimal> {
  return scalar(
    db,
    settledLedgerSql(
      Prisma.sql`l."providerAccountId" = ${input.providerAccountId}`,
      checkedCurrency(input.currency),
      input.window ?? utcMonthWindow(),
    ),
  );
}

/** This month's settled spend paid by one user (the payer: account owner, or own-key holder). */
export async function userSettledSpend(
  db: SpendReader,
  input: { userId: string; currency: string; window?: MonthWindow },
): Promise<Prisma.Decimal> {
  return scalar(
    db,
    settledLedgerSql(
      Prisma.sql`l."userId" = ${input.userId}`,
      checkedCurrency(input.currency),
      input.window ?? utcMonthWindow(),
    ),
  );
}

/** Liability of cloud attempts in flight on one provider account. */
export async function providerAccountReservedSpend(
  db: SpendReader,
  input: { providerAccountId: string; currency: string },
): Promise<Prisma.Decimal> {
  return scalar(
    db,
    reservedAttemptSql(
      Prisma.sql`a."providerAccountId" = ${input.providerAccountId}`,
      checkedCurrency(input.currency),
    ),
  );
}

/** Liability of cloud attempts in flight paid by one user. */
export async function userReservedSpend(
  db: SpendReader,
  input: { userId: string; currency: string },
): Promise<Prisma.Decimal> {
  return scalar(
    db,
    reservedAttemptSql(Prisma.sql`a."userId" = ${input.userId}`, checkedCurrency(input.currency)),
  );
}

/**
 * The provider account's spend view (`providers` contract `spend`) and its cap's consumption:
 * settled this month and reserved now, in the cap's currency (USD when uncapped), from one
 * snapshot.
 */
export async function providerAccountSpend(
  db: SpendReader,
  input: { providerAccountId: string; currency: string; now?: Date },
): Promise<SpendUsage> {
  const currency = checkedCurrency(input.currency);
  return usagePair(
    db,
    settledLedgerSql(
      Prisma.sql`l."providerAccountId" = ${input.providerAccountId}`,
      currency,
      utcMonthWindow(input.now),
    ),
    reservedAttemptSql(Prisma.sql`a."providerAccountId" = ${input.providerAccountId}`, currency),
  );
}

/**
 * Owner-paid share traffic (the share's cap): settled this month and reserved now, from one
 * snapshot. The ledger and the attempt carry the share, so a cap created mid-month, or cleared
 * and set again, still sees the whole month.
 */
export async function shareSpend(
  db: SpendReader,
  input: { shareId: string; currency: string; now?: Date },
): Promise<SpendUsage> {
  const currency = checkedCurrency(input.currency);
  return usagePair(
    db,
    settledLedgerSql(
      Prisma.sql`l."shareId" = ${input.shareId}`,
      currency,
      utcMonthWindow(input.now),
    ),
    reservedAttemptSql(Prisma.sql`a."shareId" = ${input.shareId}`, currency),
  );
}

/**
 * {@link shareSpend} for many shares in one statement (share lists), by share id. Every id in
 * `shareIds` has an entry (zero when it has no spend).
 */
export async function sharesSpend(
  db: SpendReader,
  input: { shareIds: readonly string[]; currency: string; now?: Date },
): Promise<Map<string, SpendUsage>> {
  const currency = checkedCurrency(input.currency);
  const shareIds = [...new Set(input.shareIds)];
  if (shareIds.length === 0) return new Map();
  const rows = await db.$queryRaw<Array<{ shareId: string; settled: unknown; reserved: unknown }>>`
    ${revisionsCte(Prisma.sql`l."shareId" = ANY(${shareIds}::text[])`, utcMonthWindow(input.now))},
    settled AS (
      SELECT r."shareId", SUM(r."settledCost") AS total FROM revisions r
       WHERE r.currency = ${currency} AND ${COUNTED_REVISION}
       GROUP BY r."shareId"
    ),
    reserved AS (
      SELECT a."shareId", SUM(a."liabilitySpend") AS total FROM attempt a
       WHERE a."shareId" = ANY(${shareIds}::text[])
         AND a."liabilityCurrency" = ${currency} AND ${IN_FLIGHT_ATTEMPT}
       GROUP BY a."shareId"
    )
    SELECT s.id AS "shareId",
           COALESCE(settled.total, 0)::numeric(30, 9) AS settled,
           COALESCE(reserved.total, 0)::numeric(30, 9) AS reserved
      FROM unnest(${shareIds}::text[]) AS s(id)
      LEFT JOIN settled ON settled."shareId" = s.id
      LEFT JOIN reserved ON reserved."shareId" = s.id`;
  return new Map(
    rows.map((row) => [
      row.shareId,
      { spentThisMonth: amount(row.settled), reservedNow: amount(row.reserved) },
    ]),
  );
}

/**
 * The currencies a provider account has settled spend in this month or reservations in now: a
 * cap may name only the one currency its subject has spent in this month.
 */
export function providerAccountSpendCurrencies(
  db: SpendReader,
  input: { providerAccountId: string; now?: Date },
): Promise<string[]> {
  return spendCurrencies(
    db,
    Prisma.sql`l."providerAccountId" = ${input.providerAccountId}`,
    Prisma.sql`a."providerAccountId" = ${input.providerAccountId}`,
    utcMonthWindow(input.now),
  );
}

/** {@link providerAccountSpendCurrencies} for owner-paid traffic through one share. */
export function shareSpendCurrencies(
  db: SpendReader,
  input: { shareId: string; now?: Date },
): Promise<string[]> {
  return spendCurrencies(
    db,
    Prisma.sql`l."shareId" = ${input.shareId}`,
    Prisma.sql`a."shareId" = ${input.shareId}`,
    utcMonthWindow(input.now),
  );
}
