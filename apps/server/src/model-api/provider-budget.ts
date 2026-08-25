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
    if (attempt.expiresAt.getTime() <= now.getTime())
      throw new ProviderBudgetConfigurationError(
        "Provider reservation expiry is not in the future",
      );
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
          _sum: { reservedValue: true, settledValue: true },
        });
        // Settled rows contribute actual value, live rows contribute reserved value.
        const settled =
          rule.metric === "CONCURRENCY"
            ? new Prisma.Decimal(0)
            : (aggregate._sum.settledValue ?? new Prisma.Decimal(0));
        const reserved = aggregate._sum.reservedValue ?? new Prisma.Decimal(0);
        // reservedValue includes settled rows, so subtract their reservation before adding actual.
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
        const consumed = reserved.minus(settledReserved?._sum.reservedValue ?? 0).plus(settled);
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
              row.state === "RESERVED" &&
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

function hasTrustworthyTerminalValue(
  metric: BudgetMetric,
  usage: RawProviderUsage | undefined,
): boolean {
  if (metric === "CONCURRENCY") return true;
  if (!usage) return false;
  if (metric === "TOKENS") return providerBillableTokens(usage) !== undefined;
  return usage.reportedCost !== undefined || usage.calculatedCost !== undefined;
}

/** Reconcile/release every applicable scope once. Duplicate terminal calls are safe. */
export async function reconcileProviderBudget(terminal: ProviderBudgetTerminal): Promise<void> {
  if (terminal.fencingToken <= 0n || terminal.fencingToken > MAX_SIGNED_BIGINT)
    throw new ProviderBudgetConfigurationError("Invalid fencing token");
  assertUsage(terminal.usage);
  await serializable(async (tx) => {
    const reservations = await tx.providerBudgetReservation.findMany({
      where: {
        userId: terminal.userId,
        attemptId: terminal.attemptId,
        fencingToken: terminal.fencingToken,
      },
      orderBy: { id: "asc" },
    });
    if (reservations.length === 0)
      throw new ProviderBudgetConfigurationError("No reservation exists for terminal attempt");
    const identityMatches = reservations.every(
      (row) =>
        row.providerAccountId === terminal.providerAccountId &&
        row.providerModelId === terminal.providerModelId &&
        row.poolId === (terminal.poolId ?? null) &&
        row.credentialId === (terminal.credentialId ?? null) &&
        row.requestId === terminal.requestId,
    );
    if (!identityMatches)
      throw new ProviderBudgetConfigurationError("Terminal attempt identity conflict");
    for (const reservation of reservations) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-budget:${reservation.policyId}`}, 0))`;
    }
    for (const reservation of reservations) {
      if (reservation.state !== "RESERVED") continue;
      const accountingMatches =
        terminal.usage?.accountingVersion.trim() === reservation.accountingVersion;
      const pricingMatches =
        reservation.metric !== "SPEND" ||
        (terminal.usage?.pricingVersion?.trim() === reservation.pricingVersion &&
          normalizedCurrency(terminal.usage?.currency) === reservation.currency);
      let settled = terminalValue(reservation.metric, terminal.usage);
      // Missing/untrusted usage and possibly billable failures retain the reserved
      // liability. A later repair can settle it when trustworthy usage arrives.
      if (
        !hasTrustworthyTerminalValue(reservation.metric, terminal.usage) ||
        (reservation.metric === "TOKENS" && !accountingMatches) ||
        !pricingMatches
      ) {
        settled = reservation.reservedValue;
      }
      const currency = reservation.metric === "SPEND" ? reservation.currency : null;
      await tx.providerBudgetSettlement.create({
        data: {
          userId: terminal.userId,
          reservationId: reservation.id,
          attemptId: terminal.attemptId,
          fencingToken: terminal.fencingToken,
          settledValue: settled,
          currency,
          confidence:
            accountingMatches && pricingMatches
              ? (terminal.usage?.confidence ?? "ESTIMATED")
              : "ESTIMATED",
          reason: terminal.reason,
        },
      });
      await tx.providerBudgetReservation.update({
        where: { id: reservation.id },
        data: { state: "SETTLED", settledValue: settled, settledAt: new Date() },
      });
    }

    const anchor = reservations.find((row) => row.metric === "SPEND") ?? reservations[0];
    if (!anchor) throw new ProviderBudgetConfigurationError("Reservation identity unavailable");
    const usage = terminal.usage;
    const accountingMatches = usage?.accountingVersion.trim() === anchor.accountingVersion;
    const pricingMatches =
      usage?.pricingVersion?.trim() === anchor.pricingVersion &&
      normalizedCurrency(usage?.currency) === anchor.currency;
    const suppliedCost = usage?.reportedCost ?? usage?.calculatedCost;
    const costKnown = Boolean(suppliedCost !== undefined && pricingMatches);
    const settledCost = costKnown ? decimal(suppliedCost!) : null;
    const ledgerExists = await tx.providerUsageLedger.findUnique({
      where: {
        attemptId_fencingToken: {
          attemptId: terminal.attemptId,
          fencingToken: terminal.fencingToken,
        },
      },
      select: { id: true },
    });
    if (!ledgerExists) {
      await tx.providerUsageLedger.create({
        data: {
          userId: terminal.userId,
          providerAccountId: anchor.providerAccountId,
          providerModelId: anchor.providerModelId,
          credentialId: anchor.credentialId,
          reservationId: anchor.id,
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
          rawUsage: usage?.rawUsage,
          reportedCost: pricingMatches ? usage?.reportedCost : undefined,
          calculatedCost: pricingMatches ? usage?.calculatedCost : undefined,
          settledCost,
          currency: anchor.currency,
          pricingVersion: anchor.pricingVersion,
          accountingVersion: anchor.accountingVersion,
          usageKnown: Boolean(
            usage && accountingMatches && providerBillableTokens(usage) !== undefined,
          ),
          costKnown,
          terminalReason: terminal.reason,
          confidence:
            accountingMatches && pricingMatches ? (usage?.confidence ?? "ESTIMATED") : "ESTIMATED",
        },
      });
    }
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
