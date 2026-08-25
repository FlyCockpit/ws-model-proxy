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
  if (attempt.fencingToken <= 0n || attempt.expiresAt.getTime() <= Date.now()) {
    throw new ProviderBudgetConfigurationError("Invalid provider attempt identity");
  }
  return serializable(async (tx) => {
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

    const existing = await tx.providerBudgetReservation.findMany({
      where: { attemptId: attempt.attemptId, policyId: { in: policies.map(({ id }) => id) } },
      select: { id: true },
    });
    if (existing.length > 0)
      return { admitted: true, reservationIds: existing.map(({ id }) => id) };

    const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT transaction_timestamp() AS now`;
    const now = nowRows[0]?.now;
    if (!now) throw new ProviderBudgetConfigurationError("Database clock unavailable");
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
        if (rule.metric === "SPEND" && rule.currency !== attempt.liability.currency) {
          return {
            admitted: false,
            reason: "CURRENCY_UNAVAILABLE",
            policyId: policy.id,
            ruleId: rule.id,
          };
        }
        const window = budgetWindow(rule.period, policy.activatedAt, now);
        const aggregate = await tx.providerBudgetReservation.aggregate({
          where: {
            policyId: policy.id,
            ruleId: rule.id,
            OR: [{ state: "RESERVED" }, { state: "SETTLED" }],
            ...(rule.period === "PER_ATTEMPT"
              ? { attemptId: attempt.attemptId }
              : rule.period === "LIFETIME"
                ? { windowStart: window.windowStart, windowEnd: null }
                : { windowStart: window.windowStart, windowEnd: window.windowEnd }),
          },
          _sum: { reservedValue: true, settledValue: true },
        });
        // Settled rows contribute actual value, live rows contribute reserved value.
        const settled = aggregate._sum.settledValue ?? new Prisma.Decimal(0);
        const reserved = aggregate._sum.reservedValue ?? new Prisma.Decimal(0);
        // reservedValue includes settled rows, so subtract their reservation before adding actual.
        const settledReserved = await tx.providerBudgetReservation.aggregate({
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
        const consumed = reserved.minus(settledReserved._sum.reservedValue ?? 0).plus(settled);
        if (!rule.limitValue || consumed.plus(value).greaterThan(rule.limitValue)) {
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

    const ids: string[] = [];
    for (const item of pending) {
      const row = await tx.providerBudgetReservation.create({
        data: {
          userId: attempt.userId,
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
          currency: item.rule.currency,
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
  await serializable(async (tx) => {
    const reservations = await tx.providerBudgetReservation.findMany({
      where: {
        userId: terminal.userId,
        attemptId: terminal.attemptId,
        fencingToken: terminal.fencingToken,
      },
      orderBy: { id: "asc" },
    });
    for (const reservation of reservations) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-budget:${reservation.policyId}`}, 0))`;
    }
    for (const reservation of reservations) {
      if (reservation.state !== "RESERVED") continue;
      let settled = terminalValue(reservation.metric, terminal.usage);
      // Missing/untrusted usage and possibly billable failures retain the reserved
      // liability. A later repair can settle it when trustworthy usage arrives.
      if (!hasTrustworthyTerminalValue(reservation.metric, terminal.usage)) {
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
          confidence: terminal.usage?.confidence ?? "ESTIMATED",
          reason: terminal.reason,
        },
      });
      await tx.providerBudgetReservation.update({
        where: { id: reservation.id },
        data: { state: "SETTLED", settledValue: settled, settledAt: new Date() },
      });
    }

    if (!terminal.usage?.pricingVersion || !terminal.usage.currency) return;
    const settledCost = terminalValue("SPEND", terminal.usage);
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
          providerAccountId: terminal.providerAccountId,
          providerModelId: terminal.providerModelId,
          credentialId: terminal.credentialId,
          poolId: terminal.poolId,
          requestId: terminal.requestId,
          attemptId: terminal.attemptId,
          fencingToken: terminal.fencingToken,
          inputTokens: terminal.usage.inputTokens,
          outputTokens: terminal.usage.outputTokens,
          cacheReadTokens: terminal.usage.cacheReadTokens,
          cacheWriteTokens: terminal.usage.cacheWriteTokens,
          reasoningTokens: terminal.usage.reasoningTokens,
          toolTokens: terminal.usage.toolTokens,
          rawUsage: terminal.usage.rawUsage,
          reportedCost: terminal.usage.reportedCost,
          calculatedCost: terminal.usage.calculatedCost,
          settledCost,
          currency: terminal.usage.currency,
          pricingVersion: terminal.usage.pricingVersion,
          confidence: terminal.usage.confidence,
        },
      });
    }
  });
}

/** Crash repair is conservative: expired liability is settled, never silently refunded. */
export async function repairExpiredProviderBudgets(now = new Date()): Promise<number> {
  const expired = await prisma.providerBudgetReservation.findMany({
    where: { state: "RESERVED", expiresAt: { lte: now } },
    select: { userId: true, attemptId: true, fencingToken: true, Policy: true },
    distinct: ["attemptId", "fencingToken"],
  });
  for (const row of expired) {
    await reconcileProviderBudget({
      userId: row.userId,
      providerAccountId: row.Policy.providerAccountId,
      providerModelId: row.Policy.providerModelId ?? "",
      poolId: row.Policy.poolId ?? undefined,
      requestId: "crash-recovery",
      attemptId: row.attemptId,
      fencingToken: row.fencingToken,
      reason: "CRASH_RECOVERY",
    });
  }
  return expired.length;
}
