/**
 * Cloud spend admission and accounting (monthly spend caps, spec §2.7 / §3.13), writer class H.
 *
 * A cloud attempt is an `attempt` row of kind CLOUD (the anchor: identity, fence and liability
 * snapshot). Before any provider I/O, admission reserves the attempt's liability against every
 * cap that applies (the provider account's cap and, for owner-paid share traffic, the share's)
 * and refuses it when this month's settled spend plus what is reserved now plus this liability
 * would exceed a cap. After the attempt, reconciliation appends a `usage_ledger` revision,
 * settles the reservations (`spend_settlement`, reservation RESERVED → SETTLED) and ends the
 * attempt, in one transaction. An attempt that was never sent settles at zero (the release); one
 * whose real cost is unknown keeps its liability. The repair sweep settles crashed attempts at
 * their liability. Every accounting error fails closed: admission throws (the dispatcher skips
 * the member, nothing is sent), so money is never spent without a reservation.
 *
 * Locks (packages/db/src/capacity-lock-order.ts, writer class H): the `spend-attempt` fence, then
 * the sorted `spend-cap` fences, before any row lock or write. Cap writers (M) take the same
 * `spend-cap` fence, so a cap read after the fence is the cap this admission enforces; a cap set
 * that changed between the unlocked read and the fence restarts the transaction. Provider
 * account and model rows are read without a lock, and the rows written here (attempt,
 * reservations, settlements, ledger) are hot-path rows with no foreign key into the graph.
 * Consumption is read in one statement (@ws-model-proxy/db/spend), so a settlement committing
 * concurrently is counted either as reserved or as settled, never as neither.
 */
import { createHash, randomUUID } from "node:crypto";
import prisma, { Prisma } from "@ws-model-proxy/db";
import { acquireFences, fences } from "@ws-model-proxy/db/capacity-lock-order";
import { runWithDbShutdownPermit } from "@ws-model-proxy/db/shutdown-fence";
import { providerAccountSpend, shareCapSpend } from "@ws-model-proxy/db/spend";
import { type ProviderTokenUsage, providerBillableTokens } from "./provider-budget-accounting.js";

export type BudgetMetric = "CONCURRENCY" | "TOKENS" | "SPEND";
export type UsageConfidence = "REPORTED" | "CALCULATED" | "ESTIMATED";

export interface ProviderLiability {
  /** Conservative provider-billable units, with aggregate totals de-duplicated. */
  tokens?: bigint;
  /** Conservative fixed-precision cost in pricingVersion's currency. */
  spend?: string | number | Prisma.Decimal;
  currency?: string;
  pricingVersion?: string;
  /** Immutable version of the provider usage-category accounting contract. */
  accountingVersion: string;
}

export interface ProviderBudgetAttempt {
  /** The payer: the pool owner, or the share holder for own-key traffic. */
  userId: string;
  providerAccountId: string;
  providerModelId: string;
  credentialId?: string;
  poolId?: string;
  poolMemberId?: string;
  /** The provider model's execution target. */
  targetId?: string;
  /** The share owner-paid grantee traffic runs under (its cap applies); never own-key or owner. */
  shareId?: string;
  /** The share's grantee (diagnostic; caps key on the share). */
  granteeUserId?: string;
  /** The relay request the attempt serves (`relay_request.id`). */
  requestId: string;
  attemptId: string;
  fencingToken: bigint;
  /** The caller's surface (attempt telemetry). */
  requestedSurface?: string;
  liability: ProviderLiability;
  expiresAt: Date;
}

export type ProviderBudgetAdmission =
  | { admitted: true; providerAttemptId: string; reservationIds: readonly string[] }
  | {
      admitted: false;
      reason:
        | "BUDGET_EXCEEDED"
        | "GRANTEE_BUDGET_EXCEEDED"
        | "GRANTEE_CAP_UNPRICEABLE"
        | "PROVIDER_CONCURRENCY_EXCEEDED"
        | "PROTECTION_POLICY_MISSING"
        | "CURRENCY_UNAVAILABLE"
        | "PRICING_UNAVAILABLE"
        | "TOKEN_BOUND_UNAVAILABLE";
      /** The cap that refused (internal; never shown to a grantee). */
      capId?: string;
    };

export interface RawProviderUsage extends ProviderTokenUsage {
  inputTokens?: bigint;
  outputTokens?: bigint;
  cacheReadTokens?: bigint;
  cacheWriteTokens?: bigint;
  reasoningTokens?: bigint;
  toolTokens?: bigint;
  rawUsage?: Prisma.InputJsonValue;
  /** Whether the transport reached its provider-defined terminal boundary. */
  observationComplete?: boolean;
  /** A provider total may be supplied only when it does not include the categories above. */
  reportedCost?: string | number | Prisma.Decimal;
  reportedCostCurrency?: string;
  reportedCostPricingVersion?: string;
  reportedCostSource?: string;
  calculatedCost?: string | number | Prisma.Decimal;
  calculatedCostCurrency?: string;
  calculatedCostPricingVersion?: string;
  calculatedCostSource?: string;
  /** Confidence of the local pricing calculation, independent of token provenance. */
  calculatedCostConfidence?: UsageConfidence;
  currency?: string;
  pricingVersion?: string;
  accountingVersion: string;
  confidence: UsageConfidence;
}

export interface ProviderBudgetTerminal {
  userId: string;
  providerAccountId: string;
  providerModelId: string;
  credentialId?: string;
  poolId?: string;
  requestId: string;
  attemptId: string;
  fencingToken: bigint;
  reason: "COMPLETED" | "FAILED" | "CANCELLED" | "TIMEOUT" | "CRASH_RECOVERY";
  /** Explicit proof that provider I/O never began. Omission conservatively assumes it may have. */
  dispatchOutcome?: "NOT_SENT";
  /** Stable upstream usage revision identity. */
  sourceVersion?: string;
  /** Strictly increasing per attempt fence; a duplicate delivery is idempotent. */
  revisionSequence: bigint;
  /** SNAPSHOT replaces the known total; DELTA adds newly reported usage. */
  revisionKind: "SNAPSHOT" | "DELTA";
  usageSource?: string;
  /** Whether the provider transport reached its terminal response boundary. */
  observationComplete?: boolean;
  usage?: RawProviderUsage;
  /** Internal crash-sweeper cutoff, rechecked under the attempt fence. */
  crashExpiredAt?: Date;
}

export class ProviderBudgetConfigurationError extends Error {}

/** The cap set changed between the unlocked read and its fences: restart the transaction. */
class SpendCapSetChanged extends Error {}

/** Cloud attempts are fenced by their token; the epoch only names the admitting process. */
export const PROVIDER_ATTEMPT_OWNER_EPOCH = `cloud:${randomUUID()}`;

const RETRYABLE_TRANSACTION_CODES = new Set(["P2034", "40001", "40P01"]);
const MAX_TRANSACTION_ATTEMPTS = 5;
const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;
const REPAIR_BATCH = 500;

function decimal(value: string | number | Prisma.Decimal): Prisma.Decimal {
  let result: Prisma.Decimal;
  try {
    result = new Prisma.Decimal(value);
  } catch {
    throw new ProviderBudgetConfigurationError("Invalid amount");
  }
  if (!result.isFinite() || result.isNegative())
    throw new ProviderBudgetConfigurationError("Invalid amount");
  return result;
}

function normalizedVersion(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new ProviderBudgetConfigurationError(`${label} is required`);
  return normalized;
}

function normalizedCurrency(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized))
    throw new ProviderBudgetConfigurationError("Invalid currency");
  return normalized;
}

function validToken(value: bigint | undefined): boolean {
  return value === undefined || (value >= 0n && value <= MAX_SIGNED_BIGINT);
}

export function assertUsage(usage: RawProviderUsage | undefined): void {
  if (!usage) return;
  const tokens = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    usage.reasoningTokens,
    usage.toolTokens,
    usage.additionalBillableTokens,
    usage.authoritativeBillableTokens,
    usage.reportedTotalTokens,
  ];
  if (!tokens.every(validToken)) throw new ProviderBudgetConfigurationError("Invalid token usage");
  if (usage.authoritativeBillableTokens !== undefined && usage.categoriesComplete === true)
    throw new ProviderBudgetConfigurationError("Ambiguous token accounting semantics");
  if (usage.reportedCost !== undefined) decimal(usage.reportedCost);
  if (usage.calculatedCost !== undefined) decimal(usage.calculatedCost);
  normalizedVersion(usage.accountingVersion, "accountingVersion");
  if (usage.pricingVersion !== undefined) normalizedVersion(usage.pricingVersion, "pricingVersion");
  normalizedCurrency(usage.currency);
  normalizedCurrency(usage.reportedCostCurrency);
  normalizedCurrency(usage.calculatedCostCurrency);
  if (usage.reportedCostPricingVersion !== undefined)
    normalizedVersion(usage.reportedCostPricingVersion, "reportedCostPricingVersion");
  if (usage.calculatedCostPricingVersion !== undefined)
    normalizedVersion(usage.calculatedCostPricingVersion, "calculatedCostPricingVersion");
  if (usage.reportedCostSource !== undefined)
    normalizedVersion(usage.reportedCostSource, "reportedCostSource");
  if (usage.calculatedCostSource !== undefined)
    normalizedVersion(usage.calculatedCostSource, "calculatedCostSource");
}

function canonicalPayloadHash(value: unknown): string {
  function normalize(input: unknown): unknown {
    if (typeof input === "bigint") return input.toString();
    if (input instanceof Prisma.Decimal) return input.toString();
    if (input instanceof Date) return input.toISOString();
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input)
          .filter(([, item]) => item !== undefined)
          // Code-unit order: revision identity must not vary with a replica's ICU locale.
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, item]) => [key, normalize(item)]),
      );
    return input;
  }
  return createHash("sha256")
    .update(JSON.stringify(normalize(value)))
    .digest("hex");
}

/**
 * Hashes the normalized semantics this service persists: transport metadata a caller attaches
 * does not change revision identity, and equivalent spellings stay idempotent.
 */
function terminalPayloadHash(
  terminal: ProviderBudgetTerminal,
  sourceVersion: string,
  usageSource: string,
  observationComplete: boolean | undefined,
): string {
  const usage = terminal.usage;
  return canonicalPayloadHash({
    userId: terminal.userId,
    providerAccountId: terminal.providerAccountId,
    providerModelId: terminal.providerModelId,
    credentialId: terminal.credentialId,
    poolId: terminal.poolId,
    requestId: terminal.requestId,
    attemptId: terminal.attemptId,
    fencingToken: terminal.fencingToken,
    reason: terminal.reason,
    dispatchOutcome: terminal.dispatchOutcome,
    sourceVersion,
    revisionSequence: terminal.revisionSequence,
    revisionKind: terminal.revisionKind,
    observationComplete,
    usageSource,
    usage: usage
      ? {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          reasoningTokens: usage.reasoningTokens,
          toolTokens: usage.toolTokens,
          additionalBillableTokens: usage.additionalBillableTokens,
          authoritativeBillableTokens: usage.authoritativeBillableTokens,
          reportedTotalTokens: usage.reportedTotalTokens,
          categoriesComplete: usage.categoriesComplete,
          rawUsage: usage.rawUsage,
          reportedCost: usage.reportedCost === undefined ? undefined : decimal(usage.reportedCost),
          reportedCostCurrency: normalizedCurrency(usage.reportedCostCurrency ?? usage.currency),
          reportedCostPricingVersion: (
            usage.reportedCostPricingVersion ?? usage.pricingVersion
          )?.trim(),
          calculatedCost:
            usage.calculatedCost === undefined ? undefined : decimal(usage.calculatedCost),
          calculatedCostCurrency: normalizedCurrency(
            usage.calculatedCostCurrency ?? usage.currency,
          ),
          calculatedCostPricingVersion: (
            usage.calculatedCostPricingVersion ?? usage.pricingVersion
          )?.trim(),
          calculatedCostConfidence: usage.calculatedCostConfidence,
          sourceUsageAccountingVersion: normalizedVersion(
            usage.accountingVersion,
            "accountingVersion",
          ),
          confidence: usage.confidence,
        }
      : undefined,
  });
}

function retryable(error: unknown): boolean {
  if (error instanceof SpendCapSetChanged) return true;
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    RETRYABLE_TRANSACTION_CODES.has(error.code)
  );
}

/**
 * READ COMMITTED, serialized by the spend fences: each statement after a fence wait sees what
 * the previous holder committed (SERIALIZABLE would pin the snapshot before the wait).
 */
async function serializedSpend<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await prisma.$transaction(work, { isolationLevel: "ReadCommitted" });
    } catch (error) {
      if (attempt + 1 >= MAX_TRANSACTION_ATTEMPTS || !retryable(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.floor(Math.random() * 20)));
    }
  }
}

async function databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  const now = rows[0]?.now;
  if (!now) throw new ProviderBudgetConfigurationError("Database clock unavailable");
  return now;
}

type CapRow = {
  id: string;
  scope: "PROVIDER_ACCOUNT" | "SHARE";
  monthlyLimit: Prisma.Decimal;
  currency: string;
  version: number;
};

/** The caps that bind this attempt, account cap first. A plain read: no lock. */
async function readCaps(
  tx: Prisma.TransactionClient,
  attempt: ProviderBudgetAttempt,
): Promise<CapRow[]> {
  const caps = await tx.spendCap.findMany({
    where: {
      userId: attempt.userId,
      OR: [
        { scope: "PROVIDER_ACCOUNT", providerAccountId: attempt.providerAccountId },
        ...(attempt.shareId ? [{ scope: "SHARE" as const, shareId: attempt.shareId }] : []),
      ],
    },
    select: { id: true, scope: true, monthlyLimit: true, currency: true, version: true },
  });
  return caps.sort((left, right) =>
    left.scope === right.scope
      ? left.id < right.id
        ? -1
        : 1
      : left.scope === "PROVIDER_ACCOUNT"
        ? -1
        : 1,
  );
}

function sameCapSet(left: readonly CapRow[], right: readonly CapRow[]): boolean {
  const ids = (caps: readonly CapRow[]) =>
    caps
      .map((cap) => cap.id)
      .sort()
      .join(",");
  return ids(left) === ids(right);
}

function capDenial(
  cap: CapRow,
  reason: "BUDGET_EXCEEDED" | "CURRENCY_UNAVAILABLE" | "PRICING_UNAVAILABLE",
): Extract<ProviderBudgetAdmission, { admitted: false }> {
  if (cap.scope === "SHARE")
    return {
      admitted: false,
      reason: reason === "BUDGET_EXCEEDED" ? "GRANTEE_BUDGET_EXCEEDED" : "GRANTEE_CAP_UNPRICEABLE",
      capId: cap.id,
    };
  return { admitted: false, reason, capId: cap.id };
}

/**
 * Reserves one cloud attempt's liability against every cap that applies, or refuses it.
 * Capacity admission must be released before calling this function; callers never hold a local
 * capacity lease and these reservations at once. Throws on any accounting error (fail closed).
 */
export async function admitProviderBudget(
  attempt: ProviderBudgetAttempt,
): Promise<ProviderBudgetAdmission> {
  if (
    attempt.fencingToken <= 0n ||
    attempt.fencingToken > MAX_SIGNED_BIGINT ||
    !Number.isFinite(attempt.expiresAt.getTime()) ||
    !validToken(attempt.liability.tokens)
  )
    throw new ProviderBudgetConfigurationError("Invalid provider attempt identity");
  const accountingVersion = normalizedVersion(
    attempt.liability.accountingVersion,
    "accountingVersion",
  );
  const currency = normalizedCurrency(attempt.liability.currency);
  const pricingVersion =
    attempt.liability.pricingVersion === undefined
      ? undefined
      : normalizedVersion(attempt.liability.pricingVersion, "pricingVersion");
  const liabilitySpend =
    attempt.liability.spend === undefined ? undefined : decimal(attempt.liability.spend);
  if (liabilitySpend !== undefined && (currency === undefined || pricingVersion === undefined))
    throw new ProviderBudgetConfigurationError(
      "A spend liability needs its currency and pricing version",
    );
  // A spend liability is priced only with its currency and pricing version; a currency or
  // version without an amount (an unpriceable category) is no price at all.
  const priced = liabilitySpend !== undefined;

  return serializedSpend(async (tx) => {
    // Writer class H: the attempt fence, then the cap fences (level 04 sorts after 01), before
    // any row lock or write.
    await acquireFences(tx, [fences.spendAttempt(attempt.attemptId)]);
    const unlockedCaps = await readCaps(tx, attempt);
    await acquireFences(
      tx,
      unlockedCaps.map((cap) => fences.spendCap(cap.id)),
    );
    const caps = await readCaps(tx, attempt);
    if (!sameCapSet(unlockedCaps, caps)) throw new SpendCapSetChanged();
    // The post-wait database clock, not the transaction start.
    const now = await databaseNow(tx);
    if (attempt.expiresAt.getTime() <= now.getTime())
      throw new ProviderBudgetConfigurationError("Provider attempt expiry is not in the future");

    // An attempt id is stable across delivery retries: replay returns the same reservations,
    // anything else under the same id is a conflict.
    const anchor = await tx.attempt.findUnique({ where: { id: attempt.attemptId } });
    if (anchor) {
      const exact =
        anchor.kind === "CLOUD" &&
        anchor.fencingToken === attempt.fencingToken &&
        anchor.userId === attempt.userId &&
        anchor.requestId === attempt.requestId &&
        anchor.providerAccountId === attempt.providerAccountId &&
        anchor.providerModelId === attempt.providerModelId &&
        anchor.credentialId === (attempt.credentialId ?? null) &&
        anchor.poolId === (attempt.poolId ?? null) &&
        anchor.liabilityTokens === (attempt.liability.tokens ?? null) &&
        (anchor.liabilitySpend === null
          ? liabilitySpend === undefined
          : liabilitySpend !== undefined && anchor.liabilitySpend.equals(liabilitySpend)) &&
        anchor.liabilityCurrency === (currency ?? null) &&
        anchor.pricingVersion === (pricingVersion ?? null) &&
        anchor.accountingVersion === accountingVersion;
      if (!exact) throw new ProviderBudgetConfigurationError("Attempt identity conflict");
      const settled = await tx.usageLedger.count({
        where: { attemptId: attempt.attemptId, fencingToken: attempt.fencingToken },
      });
      if (anchor.state !== "ACTIVE" || anchor.expiresAt <= now || settled > 0)
        throw new ProviderBudgetConfigurationError("Provider attempt is no longer replayable");
      const replay = await tx.spendReservation.findMany({
        where: { attemptId: attempt.attemptId, fencingToken: attempt.fencingToken },
        select: { id: true, state: true },
        orderBy: { id: "asc" },
      });
      if (replay.some((row) => row.state !== "RESERVED"))
        throw new ProviderBudgetConfigurationError("Provider attempt is no longer replayable");
      return {
        admitted: true,
        providerAttemptId: anchor.id,
        reservationIds: replay.map((row) => row.id),
      };
    }

    const model = await tx.providerModel.findFirst({
      where: {
        id: attempt.providerModelId,
        userId: attempt.userId,
        providerAccountId: attempt.providerAccountId,
        enabled: true,
        deletedAt: null,
        Account: { enabled: true, deletedAt: null },
      },
      select: { id: true },
    });
    if (!model) throw new ProviderBudgetConfigurationError("Provider model is unavailable");

    if (caps.length > 0) {
      // A cap is enforced only on a priced liability in its currency, under a pricing version
      // that is in effect now. Anything else fails closed.
      if (!priced || !currency || !pricingVersion)
        return capDenial(caps[0]!, "PRICING_UNAVAILABLE");
      const mismatched = caps.find((cap) => cap.currency !== currency);
      if (mismatched) return capDenial(mismatched, "CURRENCY_UNAVAILABLE");
      const pricing = await tx.providerPricingVersion.findFirst({
        where: {
          userId: attempt.userId,
          providerAccountId: attempt.providerAccountId,
          providerModelId: attempt.providerModelId,
          version: pricingVersion,
          currency,
          status: { in: ["ACTIVE", "RETIRED"] },
          activatedAt: { not: null },
          effectiveAt: { lte: now },
          OR: [{ retiredAt: null }, { retiredAt: { gt: now } }],
        },
        select: { id: true },
      });
      if (!pricing) return capDenial(caps[0]!, "PRICING_UNAVAILABLE");
      for (const cap of caps) {
        const usage =
          cap.scope === "SHARE"
            ? await shareCapSpend(tx, { capId: cap.id, currency, now })
            : await providerAccountSpend(tx, {
                providerAccountId: attempt.providerAccountId,
                currency,
                now,
              });
        const committed = usage.spentThisMonth.plus(usage.reservedNow).plus(liabilitySpend);
        if (committed.greaterThan(cap.monthlyLimit)) return capDenial(cap, "BUDGET_EXCEEDED");
      }
    }

    await tx.attempt.create({
      data: {
        id: attempt.attemptId,
        userId: attempt.userId,
        requestId: attempt.requestId,
        kind: "CLOUD",
        purpose: "EXECUTION",
        ownerEpoch: PROVIDER_ATTEMPT_OWNER_EPOCH,
        fencingToken: attempt.fencingToken,
        heartbeatAt: now,
        expiresAt: attempt.expiresAt,
        poolId: attempt.poolId ?? null,
        poolMemberId: attempt.poolMemberId ?? null,
        targetId: attempt.targetId ?? null,
        providerAccountId: attempt.providerAccountId,
        providerModelId: attempt.providerModelId,
        credentialId: attempt.credentialId ?? null,
        requestedSurface: attempt.requestedSurface ?? "unknown",
        liabilityTokens: attempt.liability.tokens ?? null,
        liabilitySpend: liabilitySpend ?? null,
        liabilityCurrency: currency ?? null,
        pricingVersion: pricingVersion ?? null,
        accountingVersion,
      },
    });
    const window = {
      windowStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      windowEnd: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
    };
    const reservationIds: string[] = [];
    for (const cap of caps) {
      const row = await tx.spendReservation.create({
        data: {
          userId: attempt.userId,
          capId: cap.id,
          capVersion: cap.version,
          requestId: attempt.requestId,
          attemptId: attempt.attemptId,
          fencingToken: attempt.fencingToken,
          ...window,
          // Caps exist only on priced attempts (checked above).
          reservedValue: liabilitySpend ?? new Prisma.Decimal(0),
          currency: cap.currency,
          expiresAt: attempt.expiresAt,
        },
        select: { id: true },
      });
      reservationIds.push(row.id);
    }
    return {
      admitted: true,
      providerAttemptId: attempt.attemptId,
      reservationIds: reservationIds.sort(),
    };
  });
}

type LedgerRevision = {
  revisionSequence: bigint;
  revisionKind: "SNAPSHOT" | "DELTA";
  settledCost: Prisma.Decimal | null;
};

/** An attempt's settled total: its latest SNAPSHOT plus every DELTA after it. */
function revisionTotal(revisions: readonly LedgerRevision[]): Prisma.Decimal | null {
  const ordered = [...revisions].sort((left, right) =>
    left.revisionSequence < right.revisionSequence ? -1 : 1,
  );
  let total: Prisma.Decimal | null = null;
  for (const revision of ordered) {
    if (revision.revisionKind === "SNAPSHOT") total = revision.settledCost;
    else if (revision.settledCost !== null)
      total = (total ?? new Prisma.Decimal(0)).plus(revision.settledCost);
  }
  return total;
}

function terminalState(
  reason: ProviderBudgetTerminal["reason"] | string,
): "COMPLETED" | "FAILED" | "CANCELLED" | "EXPIRED" {
  if (reason === "COMPLETED") return "COMPLETED";
  if (reason === "CANCELLED") return "CANCELLED";
  if (reason === "CRASH_RECOVERY") return "EXPIRED";
  return "FAILED";
}

/**
 * Appends one immutable accounting revision for an admitted attempt, settles its reservations
 * and ends the attempt, in one transaction. A duplicate delivery of a revision is a no-op; a
 * different payload under the same revision is a conflict.
 */
export async function reconcileProviderBudget(terminal: ProviderBudgetTerminal): Promise<void> {
  if (
    terminal.fencingToken <= 0n ||
    terminal.fencingToken > MAX_SIGNED_BIGINT ||
    terminal.revisionSequence < 0n ||
    terminal.revisionSequence > MAX_SIGNED_BIGINT
  )
    throw new ProviderBudgetConfigurationError("Invalid fencing token");
  if (
    terminal.dispatchOutcome === "NOT_SENT" &&
    (terminal.usage ||
      terminal.reason === "COMPLETED" ||
      terminal.reason === "CRASH_RECOVERY" ||
      terminal.revisionKind !== "SNAPSHOT")
  )
    throw new ProviderBudgetConfigurationError(
      "Not-sent settlement requires a failed/cancelled snapshot without usage",
    );
  assertUsage(terminal.usage);
  if (
    terminal.observationComplete !== undefined &&
    terminal.usage?.observationComplete !== undefined &&
    terminal.observationComplete !== terminal.usage.observationComplete
  )
    throw new ProviderBudgetConfigurationError("Conflicting terminal observation completeness");
  const observationComplete = terminal.observationComplete ?? terminal.usage?.observationComplete;
  const sourceVersion = normalizedVersion(
    terminal.sourceVersion ??
      (terminal.reason === "CRASH_RECOVERY" ? "crash-recovery-v1" : "terminal-v1"),
    "sourceVersion",
  );
  const usageSource = normalizedVersion(
    terminal.usageSource ?? (terminal.reason === "CRASH_RECOVERY" ? "crash-repair" : "terminal"),
    "usageSource",
  );
  const payloadHash = terminalPayloadHash(
    terminal,
    sourceVersion,
    usageSource,
    observationComplete,
  );
  // Settlement is a required durable transition: it runs even while the shutdown fence is armed
  // (the cancellation path reconciles after the request's abort). The permit covers this
  // transaction only.
  await runWithDbShutdownPermit(() =>
    serializedSpend(async (tx) => {
      // Reservations are written only under this fence, so the set read below is final.
      await acquireFences(tx, [fences.spendAttempt(terminal.attemptId)]);
      const anchor = await tx.attempt.findUnique({ where: { id: terminal.attemptId } });
      if (anchor?.kind !== "CLOUD" || anchor.fencingToken !== terminal.fencingToken)
        throw new ProviderBudgetConfigurationError("No admitted provider attempt exists");
      if (
        terminal.reason === "CRASH_RECOVERY" &&
        terminal.crashExpiredAt &&
        anchor.expiresAt > terminal.crashExpiredAt
      )
        return; // renewed by its heartbeat after the sweep selected it
      if (
        anchor.userId !== terminal.userId ||
        anchor.providerAccountId !== terminal.providerAccountId ||
        anchor.providerModelId !== terminal.providerModelId ||
        anchor.poolId !== (terminal.poolId ?? null) ||
        anchor.credentialId !== (terminal.credentialId ?? null) ||
        anchor.requestId !== terminal.requestId
      )
        throw new ProviderBudgetConfigurationError("Terminal attempt identity conflict");
      const now = await databaseNow(tx);
      const finalize = async () => {
        if (anchor.state !== "ACTIVE") return;
        await tx.attempt.updateMany({
          where: { id: anchor.id, fencingToken: anchor.fencingToken, state: "ACTIVE" },
          data: {
            state: terminalState(terminal.reason),
            terminalAt: now,
            terminalReason: terminal.reason,
          },
        });
      };

      const previous = await tx.usageLedger.findMany({
        where: { attemptId: terminal.attemptId, fencingToken: terminal.fencingToken },
        select: {
          revisionSequence: true,
          revisionKind: true,
          settledCost: true,
          payloadHash: true,
        },
      });
      const duplicate = previous.find((row) => row.revisionSequence === terminal.revisionSequence);
      if (duplicate) {
        if (
          duplicate.payloadHash !== payloadHash ||
          duplicate.revisionKind !== terminal.revisionKind
        )
          throw new ProviderBudgetConfigurationError("Accounting revision conflict");
        await finalize();
        return;
      }
      // A terminal observation that committed first always wins a crash sweep.
      if (terminal.reason === "CRASH_RECOVERY" && previous.length > 0) return;
      if (previous.some((row) => row.revisionSequence > terminal.revisionSequence))
        throw new ProviderBudgetConfigurationError("Stale accounting revision");

      const usage = terminal.usage;
      const notSent = terminal.dispatchOutcome === "NOT_SENT";
      const accountingMatches = usage?.accountingVersion.trim() === anchor.accountingVersion;
      const billableTotal = usage && providerBillableTokens(usage);
      const reportedCurrency = normalizedCurrency(usage?.reportedCostCurrency ?? usage?.currency);
      const reportedPricingVersion = (
        usage?.reportedCostPricingVersion ?? usage?.pricingVersion
      )?.trim();
      const calculatedCurrency = normalizedCurrency(
        usage?.calculatedCostCurrency ?? usage?.currency,
      );
      const calculatedPricingVersion = (
        usage?.calculatedCostPricingVersion ?? usage?.pricingVersion
      )?.trim();
      const liability = anchor.liabilitySpend;
      const reportedMatches = Boolean(
        usage?.reportedCost !== undefined &&
          anchor.pricingVersion &&
          anchor.liabilityCurrency &&
          reportedPricingVersion === anchor.pricingVersion &&
          reportedCurrency === anchor.liabilityCurrency,
      );
      const calculatedMatches = Boolean(
        usage?.calculatedCost !== undefined &&
          anchor.pricingVersion &&
          anchor.liabilityCurrency &&
          calculatedPricingVersion === anchor.pricingVersion &&
          calculatedCurrency === anchor.liabilityCurrency,
      );
      const suppliedCost = reportedMatches
        ? usage?.reportedCost
        : calculatedMatches
          ? usage?.calculatedCost
          : undefined;
      // Cost observed on an incomplete stream is evidence, but cannot reduce the admitted
      // liability: only a complete observation in the attempt's own price makes cost known.
      const costKnown = !notSent && suppliedCost !== undefined && observationComplete === true;
      const priorTotal = revisionTotal(previous);
      let revisionCost: Prisma.Decimal | null;
      let costCurrency = anchor.liabilityCurrency;
      let confidence: UsageConfidence = "ESTIMATED";
      if (notSent) revisionCost = new Prisma.Decimal(0);
      else if (costKnown && suppliedCost !== undefined) {
        revisionCost = decimal(suppliedCost);
        confidence = reportedMatches
          ? "REPORTED"
          : (usage?.calculatedCostConfidence ?? "CALCULATED");
      } else if (liability !== null) {
        // Unknown cost keeps the admitted liability (a DELTA tops the total up to it).
        revisionCost =
          terminal.revisionKind === "SNAPSHOT"
            ? liability
            : Prisma.Decimal.max(0, liability.minus(priorTotal ?? 0));
      } else if (usage?.reportedCost !== undefined && reportedCurrency) {
        // An unpriced (uncapped) attempt: keep the provider's own figure for the spend view.
        revisionCost = decimal(usage.reportedCost);
        costCurrency = reportedCurrency;
        confidence = "REPORTED";
      } else revisionCost = null;
      const total =
        terminal.revisionKind === "SNAPSHOT"
          ? revisionCost
          : revisionCost === null
            ? priorTotal
            : (priorTotal ?? new Prisma.Decimal(0)).plus(revisionCost);

      const reservations = await tx.spendReservation.findMany({
        where: { attemptId: terminal.attemptId, fencingToken: terminal.fencingToken },
        orderBy: { id: "asc" },
      });
      for (const reservation of reservations) {
        // Mirrors the ledger revision: the same SNAPSHOT/DELTA rule sums both.
        await tx.spendSettlement.create({
          data: {
            userId: reservation.userId,
            reservationId: reservation.id,
            attemptId: terminal.attemptId,
            fencingToken: terminal.fencingToken,
            sourceVersion,
            revisionSequence: terminal.revisionSequence,
            revisionKind: terminal.revisionKind,
            payloadHash,
            pricingVersion: anchor.pricingVersion,
            settledValue: revisionCost ?? new Prisma.Decimal(0),
            currency: reservation.currency,
            confidence,
            reason: terminal.reason,
          },
        });
        if (reservation.state === "RESERVED")
          await tx.spendReservation.update({
            where: { id: reservation.id },
            data: {
              state: "SETTLED",
              settledValue: total ?? new Prisma.Decimal(0),
              settledAt: now,
            },
          });
      }

      await tx.usageLedger.create({
        data: {
          userId: anchor.userId,
          providerAccountId: terminal.providerAccountId,
          providerModelId: terminal.providerModelId,
          credentialId: anchor.credentialId,
          poolId: anchor.poolId,
          requestId: anchor.requestId,
          attemptId: terminal.attemptId,
          fencingToken: terminal.fencingToken,
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
          cacheReadTokens: usage?.cacheReadTokens,
          cacheWriteTokens: usage?.cacheWriteTokens,
          reasoningTokens: usage?.reasoningTokens,
          toolTokens: usage?.toolTokens,
          additionalBillableTokens: usage?.additionalBillableTokens,
          authoritativeBillableTokens: usage?.authoritativeBillableTokens,
          reportedTotalTokens: usage?.reportedTotalTokens,
          billableTotal: accountingMatches ? billableTotal : undefined,
          categoriesComplete: usage?.categoriesComplete,
          observationComplete,
          rawUsage: usage?.rawUsage,
          reportedCost: usage?.reportedCost === undefined ? undefined : decimal(usage.reportedCost),
          reportedCostCurrency: reportedCurrency,
          calculatedCost:
            usage?.calculatedCost === undefined ? undefined : decimal(usage.calculatedCost),
          calculatedCostCurrency: calculatedCurrency,
          calculatedCostPricingVersion: calculatedPricingVersion,
          settledCost: revisionCost,
          currency: revisionCost === null ? null : costCurrency,
          pricingVersion: anchor.pricingVersion,
          sourceUsageAccountingVersion: usage
            ? normalizedVersion(usage.accountingVersion, "accountingVersion")
            : undefined,
          accountingVersion: anchor.accountingVersion ?? "provider-billable-v1",
          sourceVersion,
          revisionSequence: terminal.revisionSequence,
          revisionKind: terminal.revisionKind,
          payloadHash,
          usageSource,
          usageKnown: Boolean(
            accountingMatches && observationComplete === true && billableTotal !== undefined,
          ),
          costKnown,
          terminalReason: terminal.reason,
          confidence: costKnown
            ? confidence
            : accountingMatches
              ? (usage?.confidence ?? "ESTIMATED")
              : "ESTIMATED",
        },
      });
      await finalize();
    }),
  );
}

/**
 * Crash repair: an ACTIVE cloud attempt past its expiry is settled at its liability (never
 * silently refunded); one that already has a ledger revision only has its state ended.
 */
export async function repairExpiredProviderBudgets(
  now = new Date(),
  scope?: { userId: string; providerAccountId: string },
): Promise<number> {
  if (!Number.isFinite(now.getTime()))
    throw new ProviderBudgetConfigurationError("Invalid repair date");
  const expired = await prisma.attempt.findMany({
    where: {
      kind: "CLOUD",
      state: "ACTIVE",
      expiresAt: { lte: now },
      ...(scope ? { userId: scope.userId, providerAccountId: scope.providerAccountId } : {}),
    },
    select: {
      id: true,
      userId: true,
      requestId: true,
      fencingToken: true,
      providerAccountId: true,
      providerModelId: true,
      credentialId: true,
      poolId: true,
    },
    orderBy: { expiresAt: "asc" },
    take: REPAIR_BATCH,
  });
  let repaired = 0;
  for (const row of expired) {
    if (!row.providerAccountId || !row.providerModelId) continue;
    try {
      await repairExpiredAttempt(row, now);
      repaired += 1;
    } catch {
      // One attempt that cannot be settled must not stall the rest; the next run retries it.
      console.warn("[provider-budget] could not repair an expired cloud attempt");
    }
  }
  return repaired;
}

async function repairExpiredAttempt(
  row: {
    id: string;
    userId: string;
    requestId: string;
    fencingToken: bigint;
    providerAccountId: string | null;
    providerModelId: string | null;
    credentialId: string | null;
    poolId: string | null;
  },
  now: Date,
): Promise<void> {
  if (!row.providerAccountId || !row.providerModelId) return;
  {
    const latest = await prisma.usageLedger.findFirst({
      where: { attemptId: row.id, fencingToken: row.fencingToken },
      orderBy: { revisionSequence: "desc" },
      select: { terminalReason: true },
    });
    if (latest) {
      await runWithDbShutdownPermit(() =>
        serializedSpend(async (tx) => {
          await acquireFences(tx, [fences.spendAttempt(row.id)]);
          const terminalAt = await databaseNow(tx);
          await tx.attempt.updateMany({
            where: { id: row.id, fencingToken: row.fencingToken, state: "ACTIVE" },
            data: {
              state: terminalState(latest.terminalReason),
              terminalAt,
              terminalReason: latest.terminalReason,
            },
          });
        }),
      );
    } else {
      await reconcileProviderBudget({
        userId: row.userId,
        providerAccountId: row.providerAccountId,
        providerModelId: row.providerModelId,
        credentialId: row.credentialId ?? undefined,
        poolId: row.poolId ?? undefined,
        requestId: row.requestId,
        attemptId: row.id,
        fencingToken: row.fencingToken,
        reason: "CRASH_RECOVERY",
        crashExpiredAt: now,
        revisionSequence: 0n,
        revisionKind: "SNAPSHOT",
      });
    }
  }
}

export type { ProviderTokenUsage };
