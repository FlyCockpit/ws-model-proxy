import prisma, { Prisma } from "@ws-model-proxy/db";
import {
  budgetWindow,
  type ProviderTokenUsage,
  providerBillableTokens,
} from "./provider-budget-accounting.js";

export { budgetWindow, providerBillableTokens } from "./provider-budget-accounting.js";

const RETRYABLE_TRANSACTION_CODES = new Set(["P2034", "40001", "40P01"]);
const MAX_TRANSACTION_ATTEMPTS = 5;

export type BudgetMetric = "CONCURRENCY" | "TOKENS" | "SPEND";
export type { BudgetPeriod } from "./provider-budget-accounting.js";
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
  userId: string;
  providerAccountId: string;
  providerModelId: string;
  credentialId?: string;
  poolId?: string;
  requestId: string;
  attemptId: string;
  fencingToken: bigint;
  liability: ProviderLiability;
  expiresAt: Date;
}

export type ProviderBudgetAdmission =
  | { admitted: true; reservationIds: readonly string[] }
  | {
      admitted: false;
      reason:
        | "BUDGET_EXCEEDED"
        | "CURRENCY_UNAVAILABLE"
        | "PRICING_UNAVAILABLE"
        | "TOKEN_BOUND_UNAVAILABLE";
      policyId: string;
      ruleId: string;
    };

export interface RawProviderUsage extends ProviderTokenUsage {
  inputTokens?: bigint;
  outputTokens?: bigint;
  cacheReadTokens?: bigint;
  cacheWriteTokens?: bigint;
  reasoningTokens?: bigint;
  toolTokens?: bigint;
  rawUsage?: Prisma.InputJsonValue;
  /** A provider total may be supplied only when it does not include the categories above. */
  reportedCost?: string | number | Prisma.Decimal;
  calculatedCost?: string | number | Prisma.Decimal;
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
  /** Stable upstream usage revision identity. Duplicate delivery is idempotent. */
  sourceVersion?: string;
  usageSource?: string;
  usage?: RawProviderUsage;
}

export class ProviderBudgetConfigurationError extends Error {}

function decimal(value: string | number | Prisma.Decimal): Prisma.Decimal {
  const result = new Prisma.Decimal(value);
  if (!result.isFinite() || result.isNegative()) throw new ProviderBudgetConfigurationError();
  return result;
}

const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;

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

function assertUsage(usage: RawProviderUsage | undefined): void {
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
  ];
  if (!tokens.every(validToken)) throw new ProviderBudgetConfigurationError("Invalid token usage");
  if (usage.authoritativeBillableTokens !== undefined && usage.categoriesComplete === true)
    throw new ProviderBudgetConfigurationError("Ambiguous token accounting semantics");
  if (usage.reportedCost !== undefined) decimal(usage.reportedCost);
  if (usage.calculatedCost !== undefined) decimal(usage.calculatedCost);
  normalizedVersion(usage.accountingVersion, "accountingVersion");
  if (usage.pricingVersion !== undefined) normalizedVersion(usage.pricingVersion, "pricingVersion");
  normalizedCurrency(usage.currency);
}

function reservationValue(
  metric: BudgetMetric,
  liability: ProviderLiability,
): Prisma.Decimal | null {
  if (metric === "CONCURRENCY") return new Prisma.Decimal(1);
  if (metric === "TOKENS")
    return liability.tokens === undefined ? null : new Prisma.Decimal(liability.tokens.toString());
  return liability.spend === undefined ? null : decimal(liability.spend);
}

function retryable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    RETRYABLE_TRANSACTION_CODES.has(error.code)
  );
}

async function serializable<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await prisma.$transaction(work, { isolationLevel: "Serializable" });
    } catch (error) {
      if (attempt + 1 >= MAX_TRANSACTION_ATTEMPTS || !retryable(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.floor(Math.random() * 20)));
    }
  }
}

/**
 * Atomic admission across the attachment policy and shared account policy.
 * Capacity admission must be released before calling this function; callers
 * must never hold both a local capacity lease and these provider reservations.
 */
export async function admitProviderBudget(
  attempt: ProviderBudgetAttempt,
): Promise<ProviderBudgetAdmission> {
  if (
    attempt.fencingToken <= 0n ||
    attempt.fencingToken > MAX_SIGNED_BIGINT ||
    !Number.isFinite(attempt.expiresAt.getTime()) ||
    !validToken(attempt.liability.tokens)
  ) {
    throw new ProviderBudgetConfigurationError("Invalid provider attempt identity");
  }
  const accountingVersion = normalizedVersion(
    attempt.liability.accountingVersion,
    "accountingVersion",
  );
  const pricingVersion = attempt.liability.pricingVersion
    ? normalizedVersion(attempt.liability.pricingVersion, "pricingVersion")
    : undefined;
  const currency = normalizedCurrency(attempt.liability.currency);
  const liabilitySpend =
    attempt.liability.spend === undefined ? undefined : decimal(attempt.liability.spend);
  return serializable(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-budget-attempt:${attempt.attemptId}`}, 0))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-budget-account:${attempt.userId}:${attempt.providerAccountId}`}, 0))`;
    const policies = await tx.providerBudgetPolicy.findMany({
      where: {
        userId: attempt.userId,
        providerAccountId: attempt.providerAccountId,
        active: true,
        OR: [
          { scopeType: "PROVIDER_ACCOUNT", poolId: null, providerModelId: null },
          ...(attempt.poolId
            ? [
                {
                  scopeType: "POOL_PROVIDER_MODEL" as const,
                  poolId: attempt.poolId,
                  providerModelId: attempt.providerModelId,
                },
              ]
            : []),
        ],
      },
      include: { Rules: true },
      orderBy: { id: "asc" },
    });
    for (const policy of policies) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-budget:${policy.id}`}, 0))`;
    }

    const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT transaction_timestamp() AS now`;
    const now = nowRows[0]?.now;
    if (!now) throw new ProviderBudgetConfigurationError("Database clock unavailable");
    const hasCostIdentity =
      liabilitySpend !== undefined || currency !== undefined || pricingVersion !== undefined;
    if (
      hasCostIdentity &&
      (liabilitySpend === undefined || currency === undefined || pricingVersion === undefined)
    )
      throw new ProviderBudgetConfigurationError(
        "Spend liability, currency, and pricingVersion must be supplied together",
      );
    const attemptAnchor = await tx.providerAttempt.findUnique({
      where: {
        attemptId_fencingToken: {
          attemptId: attempt.attemptId,
          fencingToken: attempt.fencingToken,
        },
      },
    });
    if (attemptAnchor) {
      const exact =
        attemptAnchor.userId === attempt.userId &&
        attemptAnchor.providerAccountId === attempt.providerAccountId &&
        attemptAnchor.providerModelId === attempt.providerModelId &&
        attemptAnchor.credentialId === (attempt.credentialId ?? null) &&
        attemptAnchor.poolId === (attempt.poolId ?? null) &&
        attemptAnchor.requestId === attempt.requestId &&
        attemptAnchor.expiresAt.getTime() === attempt.expiresAt.getTime() &&
        attemptAnchor.liabilityTokens === (attempt.liability.tokens ?? null) &&
        (attemptAnchor.liabilitySpend?.equals(liabilitySpend ?? 0) ??
          liabilitySpend === undefined) &&
        attemptAnchor.liabilityCurrency === (currency ?? null) &&
        attemptAnchor.pricingVersion === (pricingVersion ?? null) &&
        attemptAnchor.accountingVersion === accountingVersion;
      if (!exact)
        throw new ProviderBudgetConfigurationError("Attempt identity or liability conflict");
      const replay = await tx.providerBudgetReservation.findMany({
        where: { attemptId: attempt.attemptId, fencingToken: attempt.fencingToken },
        orderBy: { id: "asc" },
        select: { id: true },
      });
      return { admitted: true, reservationIds: replay.map(({ id }) => id) };
    }
    if (attempt.expiresAt.getTime() <= now.getTime())
      throw new ProviderBudgetConfigurationError(
        "Provider reservation expiry is not in the future",
      );
    if (hasCostIdentity) {
      const pricing = await tx.providerPricingVersion.findFirst({
        where: {
          userId: attempt.userId,
          providerAccountId: attempt.providerAccountId,
          providerModelId: attempt.providerModelId,
          version: pricingVersion,
          currency,
          effectiveAt: { lte: now },
          OR: [{ retiredAt: null }, { retiredAt: { gt: now } }],
        },
        select: { id: true },
      });
      if (!pricing) throw new ProviderBudgetConfigurationError("Pricing identity is unavailable");
    }
    const existing = await tx.providerBudgetReservation.findMany({
      where: { attemptId: attempt.attemptId },
      orderBy: { id: "asc" },
    });
    const pending: Array<{
      policy: (typeof policies)[number];
      rule: (typeof policies)[number]["Rules"][number];
      value: Prisma.Decimal;
      windowStart: Date | null;
      windowEnd: Date | null;
    }> = [];

    for (const policy of policies) {
      if (!policy.activatedAt)
        throw new ProviderBudgetConfigurationError("Active policy has no activation");
      for (const rule of policy.Rules.sort((left, right) => left.id.localeCompare(right.id))) {
        if (rule.mode === "UNLIMITED") continue;
        const value = reservationValue(rule.metric, attempt.liability);
        if (value === null) {
          return {
            admitted: false,
            reason: rule.metric === "TOKENS" ? "TOKEN_BOUND_UNAVAILABLE" : "PRICING_UNAVAILABLE",
            policyId: policy.id,
            ruleId: rule.id,
          };
        }
        if (rule.metric === "SPEND" && rule.currency !== currency) {
          return {
            admitted: false,
            reason: "CURRENCY_UNAVAILABLE",
            policyId: policy.id,
            ruleId: rule.id,
          };
        }
        if (rule.metric === "SPEND" && !pricingVersion) {
          return {
            admitted: false,
            reason: "PRICING_UNAVAILABLE",
            policyId: policy.id,
            ruleId: rule.id,
          };
        }
        if (rule.metric === "SPEND") {
          const pricing = await tx.providerPricingVersion.findFirst({
            where: {
              userId: attempt.userId,
              providerAccountId: attempt.providerAccountId,
              providerModelId: attempt.providerModelId,
              version: pricingVersion,
              currency,
              effectiveAt: { lte: now },
              OR: [{ retiredAt: null }, { retiredAt: { gt: now } }],
            },
            select: { id: true },
          });
          if (!pricing)
            return {
              admitted: false,
              reason: "PRICING_UNAVAILABLE",
              policyId: policy.id,
              ruleId: rule.id,
            };
        }
        const window = budgetWindow(rule.period, policy.activatedAt, now);
        const aggregate = await tx.providerBudgetReservation.aggregate({
          where: {
            policyId: policy.id,
            ruleId: rule.id,
            ...(rule.metric === "CONCURRENCY"
              ? {
                  state: "RESERVED",
                  OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
                }
              : { OR: [{ state: "RESERVED" }, { state: "SETTLED" }] }),
            ...(rule.metric === "CONCURRENCY"
              ? {}
              : rule.period === "PER_ATTEMPT"
                ? { attemptId: attempt.attemptId }
                : rule.period === "LIFETIME"
                  ? { windowStart: window.windowStart, windowEnd: null }
                  : { windowStart: window.windowStart, windowEnd: window.windowEnd }),
          },
          _sum: { reservedValue: true },
        });
        const reserved = aggregate._sum.reservedValue ?? new Prisma.Decimal(0);
        const settledReserved =
          rule.metric === "CONCURRENCY"
            ? null
            : await tx.providerBudgetReservation.aggregate({
                where: {
                  policyId: policy.id,
                  ruleId: rule.id,
                  state: "SETTLED",
                  ...(rule.period === "PER_ATTEMPT"
                    ? { attemptId: attempt.attemptId }
                    : rule.period === "LIFETIME"
                      ? { windowStart: window.windowStart, windowEnd: null }
                      : { windowStart: window.windowStart, windowEnd: window.windowEnd }),
                },
                _sum: { reservedValue: true },
              });
        const settlementAggregate =
          rule.metric === "CONCURRENCY"
            ? null
            : await tx.providerBudgetSettlement.aggregate({
                where: {
                  Reservation: {
                    policyId: policy.id,
                    ruleId: rule.id,
                    ...(rule.period === "PER_ATTEMPT"
                      ? { attemptId: attempt.attemptId }
                      : rule.period === "LIFETIME"
                        ? { windowStart: window.windowStart, windowEnd: null }
                        : { windowStart: window.windowStart, windowEnd: window.windowEnd }),
                  },
                },
                _sum: { settledValue: true },
              });
        const consumed = reserved
          .minus(settledReserved?._sum.reservedValue ?? 0)
          .plus(settlementAggregate?._sum.settledValue ?? 0);
        if (
          existing.length === 0 &&
          (!rule.limitValue || consumed.plus(value).greaterThan(rule.limitValue))
        ) {
          return {
            admitted: false,
            reason: "BUDGET_EXCEEDED",
            policyId: policy.id,
            ruleId: rule.id,
          };
        }
        pending.push({ policy, rule, value, ...window });
      }
    }

    if (existing.length > 0) {
      const expected = new Map(pending.map((item) => [`${item.policy.id}:${item.rule.id}`, item]));
      const exact =
        existing.length === pending.length &&
        existing.every((row) => {
          const item = expected.get(`${row.policyId}:${row.ruleId}`);
          return Boolean(
            item &&
              row.userId === attempt.userId &&
              row.providerAccountId === attempt.providerAccountId &&
              row.providerModelId === attempt.providerModelId &&
              row.poolId === (attempt.poolId ?? null) &&
              row.credentialId === (attempt.credentialId ?? null) &&
              row.requestId === attempt.requestId &&
              row.fencingToken === attempt.fencingToken &&
              row.policyVersion === item.policy.version &&
              row.reservedValue.equals(item.value) &&
              row.liabilityTokens === (attempt.liability.tokens ?? null) &&
              (row.liabilitySpend?.equals(liabilitySpend ?? 0) ?? liabilitySpend === undefined) &&
              row.liabilityCurrency === (currency ?? null) &&
              row.currency === item.rule.currency &&
              row.pricingVersion === (pricingVersion ?? null) &&
              row.accountingVersion === accountingVersion &&
              row.expiresAt?.getTime() === attempt.expiresAt.getTime(),
          );
        });
      if (!exact)
        throw new ProviderBudgetConfigurationError(
          "Attempt identity or active policy set conflict",
        );
      return { admitted: true, reservationIds: existing.map(({ id }) => id) };
    }

    await tx.providerAttempt.create({
      data: {
        userId: attempt.userId,
        providerAccountId: attempt.providerAccountId,
        providerModelId: attempt.providerModelId,
        credentialId: attempt.credentialId,
        poolId: attempt.poolId,
        requestId: attempt.requestId,
        attemptId: attempt.attemptId,
        fencingToken: attempt.fencingToken,
        expiresAt: attempt.expiresAt,
        liabilityTokens: attempt.liability.tokens,
        liabilitySpend,
        liabilityCurrency: currency,
        pricingVersion,
        accountingVersion,
      },
    });
    const ids: string[] = [];
    for (const item of pending) {
      const row = await tx.providerBudgetReservation.create({
        data: {
          userId: attempt.userId,
          providerAccountId: attempt.providerAccountId,
          providerModelId: attempt.providerModelId,
          poolId: attempt.poolId,
          policyId: item.policy.id,
          ruleId: item.rule.id,
          credentialId: attempt.credentialId,
          requestId: attempt.requestId,
          attemptId: attempt.attemptId,
          fencingToken: attempt.fencingToken,
          metric: item.rule.metric,
          period: item.rule.period,
          policyVersion: item.policy.version,
          windowStart: item.windowStart,
          windowEnd: item.windowEnd,
          reservedValue: item.value,
          liabilityTokens: attempt.liability.tokens,
          liabilitySpend,
          liabilityCurrency: currency,
          currency: item.rule.currency,
          pricingVersion,
          accountingVersion,
          expiresAt: attempt.expiresAt,
        },
        select: { id: true },
      });
      ids.push(row.id);
    }
    return { admitted: true, reservationIds: ids };
  });
}

function terminalValue(metric: BudgetMetric, usage: RawProviderUsage | undefined): Prisma.Decimal {
  if (metric === "CONCURRENCY") return new Prisma.Decimal(0);
  if (metric === "TOKENS") {
    const tokens = usage && providerBillableTokens(usage);
    return tokens === undefined ? new Prisma.Decimal(0) : new Prisma.Decimal(tokens.toString());
  }
  if (!usage) return new Prisma.Decimal(0);
  const value = usage.reportedCost ?? usage.calculatedCost;
  return value === undefined ? new Prisma.Decimal(0) : decimal(value);
}

/** Append one immutable accounting revision. Duplicate source revisions are safe. */
export async function reconcileProviderBudget(terminal: ProviderBudgetTerminal): Promise<void> {
  if (terminal.fencingToken <= 0n || terminal.fencingToken > MAX_SIGNED_BIGINT)
    throw new ProviderBudgetConfigurationError("Invalid fencing token");
  assertUsage(terminal.usage);
  const sourceVersion = normalizedVersion(
    terminal.sourceVersion ??
      (terminal.reason === "CRASH_RECOVERY" ? "crash-recovery-v1" : "terminal-v1"),
    "sourceVersion",
  );
  const usageSource = normalizedVersion(
    terminal.usageSource ?? (terminal.reason === "CRASH_RECOVERY" ? "crash-repair" : "terminal"),
    "usageSource",
  );
  await serializable(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-budget-attempt:${terminal.attemptId}`}, 0))`;
    const anchor = await tx.providerAttempt.findUnique({
      where: {
        attemptId_fencingToken: {
          attemptId: terminal.attemptId,
          fencingToken: terminal.fencingToken,
        },
      },
    });
    if (!anchor) throw new ProviderBudgetConfigurationError("No admitted provider attempt exists");
    if (
      anchor.userId !== terminal.userId ||
      anchor.providerAccountId !== terminal.providerAccountId ||
      anchor.providerModelId !== terminal.providerModelId ||
      anchor.poolId !== (terminal.poolId ?? null) ||
      anchor.credentialId !== (terminal.credentialId ?? null) ||
      anchor.requestId !== terminal.requestId
    )
      throw new ProviderBudgetConfigurationError("Terminal attempt identity conflict");

    const priorRevision = await tx.providerUsageLedger.findUnique({
      where: {
        attemptId_fencingToken_sourceVersion: {
          attemptId: terminal.attemptId,
          fencingToken: terminal.fencingToken,
          sourceVersion,
        },
      },
      select: { id: true },
    });
    if (priorRevision) return;
    const previousLedgers = await tx.providerUsageLedger.findMany({
      where: { attemptId: terminal.attemptId, fencingToken: terminal.fencingToken },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    // A completed terminal observation always wins a crash sweep that selected
    // the row just before the terminal transaction committed.
    if (terminal.reason === "CRASH_RECOVERY" && previousLedgers.length > 0) return;

    const reservations = await tx.providerBudgetReservation.findMany({
      where: {
        userId: terminal.userId,
        attemptId: terminal.attemptId,
        fencingToken: terminal.fencingToken,
      },
      orderBy: { id: "asc" },
    });
    for (const reservation of reservations)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-budget:${reservation.policyId}`}, 0))`;

    const usage = terminal.usage;
    const billableTotal = usage && providerBillableTokens(usage);
    const accountingMatches = usage?.accountingVersion.trim() === anchor.accountingVersion;
    const pricingMatches = Boolean(
      anchor.pricingVersion &&
        anchor.liabilityCurrency &&
        usage?.pricingVersion?.trim() === anchor.pricingVersion &&
        normalizedCurrency(usage?.currency) === anchor.liabilityCurrency,
    );
    const suppliedCost = usage?.reportedCost ?? usage?.calculatedCost;
    const costKnown = suppliedCost !== undefined && pricingMatches;
    const settledCost = costKnown ? decimal(suppliedCost) : null;

    for (const reservation of reservations) {
      const trustworthy =
        reservation.metric === "CONCURRENCY" ||
        (reservation.metric === "TOKENS" && accountingMatches && billableTotal !== undefined) ||
        (reservation.metric === "SPEND" && costKnown);
      const desiredTotal = trustworthy
        ? terminalValue(reservation.metric, usage)
        : reservation.reservedValue;
      const prior = await tx.providerBudgetSettlement.aggregate({
        where: { reservationId: reservation.id },
        _sum: { settledValue: true },
      });
      const delta = desiredTotal.minus(prior._sum.settledValue ?? 0);
      await tx.providerBudgetSettlement.create({
        data: {
          userId: terminal.userId,
          reservationId: reservation.id,
          attemptId: terminal.attemptId,
          fencingToken: terminal.fencingToken,
          sourceVersion,
          settledValue: delta,
          currency: reservation.metric === "SPEND" ? reservation.currency : null,
          confidence: trustworthy ? (usage?.confidence ?? "ESTIMATED") : "ESTIMATED",
          reason: terminal.reason,
        },
      });
      if (reservation.state === "RESERVED")
        await tx.providerBudgetReservation.update({
          where: { id: reservation.id },
          data: { state: "SETTLED", settledValue: desiredTotal, settledAt: new Date() },
        });
    }

    await tx.providerUsageLedger.create({
      data: {
        userId: terminal.userId,
        providerAccountId: anchor.providerAccountId,
        providerModelId: anchor.providerModelId,
        credentialId: anchor.credentialId,
        reservationId: reservations[0]?.id,
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
        billableTotal: accountingMatches ? billableTotal : undefined,
        categoriesComplete: usage?.categoriesComplete,
        rawUsage: usage?.rawUsage,
        reportedCost: pricingMatches ? usage?.reportedCost : undefined,
        calculatedCost: pricingMatches ? usage?.calculatedCost : undefined,
        settledCost,
        currency: anchor.liabilityCurrency,
        pricingVersion: anchor.pricingVersion,
        accountingVersion: anchor.accountingVersion,
        sourceVersion,
        usageSource,
        usageKnown: Boolean(accountingMatches && billableTotal !== undefined),
        costKnown,
        terminalReason: terminal.reason,
        confidence:
          accountingMatches && (suppliedCost === undefined || pricingMatches)
            ? (usage?.confidence ?? "ESTIMATED")
            : "ESTIMATED",
      },
    });
  });
}

/** Crash repair is conservative: expired liability is settled, never silently refunded. */
export async function repairExpiredProviderBudgets(now = new Date()): Promise<number> {
  if (!Number.isFinite(now.getTime()))
    throw new ProviderBudgetConfigurationError("Invalid repair date");
  const expired = await prisma.providerBudgetReservation.findMany({
    where: { state: "RESERVED", expiresAt: { lte: now } },
    select: {
      userId: true,
      providerAccountId: true,
      providerModelId: true,
      credentialId: true,
      poolId: true,
      requestId: true,
      attemptId: true,
      fencingToken: true,
    },
    distinct: ["attemptId", "fencingToken"],
  });
  for (const row of expired) {
    await reconcileProviderBudget({
      userId: row.userId,
      providerAccountId: row.providerAccountId,
      providerModelId: row.providerModelId,
      credentialId: row.credentialId ?? undefined,
      poolId: row.poolId ?? undefined,
      requestId: row.requestId,
      attemptId: row.attemptId,
      fencingToken: row.fencingToken,
      reason: "CRASH_RECOVERY",
    });
  }
  return expired.length;
}
