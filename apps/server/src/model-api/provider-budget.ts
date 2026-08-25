import { createHash } from "node:crypto";
import prisma, { Prisma } from "@ws-model-proxy/db";
import {
  budgetWindow,
  type ProviderTokenUsage,
  providerBillableTokens,
} from "./provider-budget-accounting.js";

export { budgetWindow, providerBillableTokens } from "./provider-budget-accounting.js";

const RETRYABLE_TRANSACTION_CODES = new Set(["P2034", "40001", "40P01"]);
const MAX_TRANSACTION_ATTEMPTS = 5;

let terminalPersistenceTestFailure: (() => unknown) | undefined;

export function setTerminalPersistenceTestFailureInjector(injector: (() => unknown) | undefined) {
  if (process.env.NODE_ENV !== "test")
    throw new Error("Terminal persistence failure injection is test-only");
  terminalPersistenceTestFailure = injector;
}

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
  | { admitted: true; providerAttemptId: string; reservationIds: readonly string[] }
  | {
      admitted: false;
      reason:
        | "BUDGET_EXCEEDED"
        | "PROVIDER_CONCURRENCY_EXCEEDED"
        | "PROTECTION_POLICY_MISSING"
        | "CURRENCY_UNAVAILABLE"
        | "PRICING_UNAVAILABLE"
        | "TOKEN_BOUND_UNAVAILABLE";
      policyId?: string;
      ruleId?: string;
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
  /** Stable upstream usage revision identity. Duplicate delivery is idempotent. */
  sourceVersion?: string;
  /** Provider-scoped, strictly increasing sequence for this attempt. */
  revisionSequence: bigint;
  /** SNAPSHOT replaces the known total; DELTA adds newly reported usage. */
  revisionKind: "SNAPSHOT" | "DELTA";
  usageSource?: string;
  /** Whether the provider transport reached its terminal response boundary. */
  observationComplete?: boolean;
  usage?: RawProviderUsage;
  /** Internal crash-sweeper cutoff, rechecked under the attempt advisory lock. */
  crashExpiredAt?: Date;
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
        Object.entries(input as Record<string, unknown>)
          .filter(([, item]) => item !== undefined)
          // JSON object keys are UTF-16 strings. Compare code units directly so
          // revision identity cannot vary with a replica's ICU locale.
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
 * Hash only the normalized semantics that this service persists. In particular,
 * callers may attach transport metadata without changing revision identity, and
 * equivalent currency/version/source spelling must remain idempotent.
 */
function terminalPayloadHash(
  terminal: ProviderBudgetTerminal,
  sourceVersion: string,
  usageSource: string,
  accountingMatches: boolean,
  observationComplete: boolean | undefined,
): string {
  const usage = terminal.usage;
  const sourceUsageAccountingVersion = usage
    ? normalizedVersion(usage.accountingVersion, "accountingVersion")
    : undefined;
  const normalizedUsage = usage
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
        reportedCostPricingVersion:
          usage.reportedCostPricingVersion === undefined && usage.pricingVersion === undefined
            ? undefined
            : normalizedVersion(
                usage.reportedCostPricingVersion ?? usage.pricingVersion,
                "reportedCostPricingVersion",
              ),
        reportedCostSource:
          usage.reportedCost === undefined
            ? undefined
            : normalizedVersion(usage.reportedCostSource ?? usageSource, "reportedCostSource"),
        calculatedCost:
          usage.calculatedCost === undefined ? undefined : decimal(usage.calculatedCost),
        calculatedCostCurrency: normalizedCurrency(usage.calculatedCostCurrency ?? usage.currency),
        calculatedCostPricingVersion:
          usage.calculatedCostPricingVersion === undefined && usage.pricingVersion === undefined
            ? undefined
            : normalizedVersion(
                usage.calculatedCostPricingVersion ?? usage.pricingVersion,
                "calculatedCostPricingVersion",
              ),
        calculatedCostSource:
          usage.calculatedCost === undefined
            ? undefined
            : normalizedVersion(usage.calculatedCostSource ?? usageSource, "calculatedCostSource"),
        billableTotal: accountingMatches ? providerBillableTokens(usage) : undefined,
        sourceUsageAccountingVersion,
        confidence: usage.confidence,
      }
    : undefined;
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
    sourceVersion,
    revisionSequence: terminal.revisionSequence,
    revisionKind: terminal.revisionKind,
    observationComplete,
    usageSource,
    usage: normalizedUsage,
  });
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

async function serializedByAdvisoryLocks<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      // The first statement acquires an account/attempt advisory lock. Under
      // PostgreSQL SERIALIZABLE that statement also fixes a snapshot before a
      // contending policy replacement commits, leaving subsequent reads stale
      // after the lock is granted. READ COMMITTED refreshes the snapshot after
      // each waited lock; the advisory locks provide the serialization here.
      return await prisma.$transaction(work, { isolationLevel: "ReadCommitted" });
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
  return serializedByAdvisoryLocks(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-budget-attempt:${attempt.attemptId}`}, 0))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-budget-account:${attempt.userId}:${attempt.providerAccountId}`}, 0))`;
    // This statement runs after possibly waiting for the account lock. Use the
    // actual post-wait database clock, not this transaction's start time, when
    // evaluating newly committed activation/effective/expiry boundaries.
    const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
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
    // A dispatch attempt ID is globally stable across delivery retries. A new
    // fencing token must use a new attempt ID; otherwise reservations from the
    // first fence could be orphaned or charged to the second execution.
    const attemptAnchor = await tx.providerAttempt.findFirst({
      where: { attemptId: attempt.attemptId },
      orderBy: { createdAt: "asc" },
    });
    if (attemptAnchor) {
      const exact =
        attemptAnchor.fencingToken === attempt.fencingToken &&
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
        select: { id: true, policyId: true, ruleId: true, state: true, expiresAt: true },
      });
      const hasTerminal = await tx.providerUsageLedger.count({
        where: { attemptId: attempt.attemptId, fencingToken: attempt.fencingToken },
      });
      const completeLiveReservedSet =
        attemptAnchor.expiresAt.getTime() > now.getTime() &&
        hasTerminal === 0 &&
        replay.every(
          (row) =>
            row.state === "RESERVED" &&
            row.expiresAt !== null &&
            row.expiresAt.getTime() > now.getTime(),
        );
      if (!completeLiveReservedSet)
        throw new ProviderBudgetConfigurationError("Provider attempt is no longer replayable");
      return {
        admitted: true,
        providerAttemptId: attemptAnchor.id,
        reservationIds: replay.map(({ id }) => id),
      };
    }
    // The provider model's physical concurrency ceiling is admitted under the
    // same account lock and transaction as financial/token budgets. Live
    // attempt anchors remain liabilities until terminal reconciliation or
    // expiry, including attempts with no explicit budget policies.
    const providerModel = await tx.providerModel.findFirst({
      where: {
        id: attempt.providerModelId,
        userId: attempt.userId,
        providerAccountId: attempt.providerAccountId,
        enabled: true,
        deletedAt: null,
      },
      select: { concurrencyLimit: true },
    });
    if (!providerModel) throw new ProviderBudgetConfigurationError("Provider model is unavailable");
    if (providerModel.concurrencyLimit !== null) {
      const live = await tx.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count
          FROM provider_attempt attempt
         WHERE attempt."userId" = ${attempt.userId}
           AND attempt."providerModelId" = ${attempt.providerModelId}
           AND attempt."expiresAt" > ${now}
           AND NOT EXISTS (
             SELECT 1 FROM provider_usage_ledger ledger
              WHERE ledger."attemptId" = attempt."attemptId"
                AND ledger."fencingToken" = attempt."fencingToken"
           )`;
      if ((live[0]?.count ?? 0n) >= BigInt(providerModel.concurrencyLimit)) {
        return { admitted: false, reason: "PROVIDER_CONCURRENCY_EXCEEDED" };
      }
    }
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
    // Public egress is fail-closed: an account-wide policy may add additional
    // limits, but it does not constitute consent for a particular pool/model
    // attachment. That attachment needs its own active policy, including an
    // explicit concurrency decision. LIMITED is enforced below; UNLIMITED is
    // an intentional persisted rule (and its policy creation is audited by the
    // management API), never an implicit null/default.
    const attachmentPolicies = policies.filter(
      (policy) =>
        policy.scopeType === "POOL_PROVIDER_MODEL" &&
        policy.poolId === attempt.poolId &&
        policy.providerModelId === attempt.providerModelId,
    );
    if (
      attempt.poolId !== undefined &&
      (attachmentPolicies.length === 0 ||
        !attachmentPolicies.some((policy) =>
          policy.Rules.some(
            (rule) => rule.metric === "CONCURRENCY" && rule.period === "PER_ATTEMPT",
          ),
        ))
    ) {
      return { admitted: false, reason: "PROTECTION_POLICY_MISSING" };
    }
    for (const policy of policies) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-budget:${policy.id}`}, 0))`;
    }
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
              status: { in: ["ACTIVE", "RETIRED"] },
              activatedAt: { not: null },
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
      throw new ProviderBudgetConfigurationError(
        "Budget reservations exist without their provider attempt anchor",
      );
    }

    const providerAttempt = await tx.providerAttempt.create({
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
    return { admitted: true, providerAttemptId: providerAttempt.id, reservationIds: ids.sort() };
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
  if (
    terminal.fencingToken <= 0n ||
    terminal.fencingToken > MAX_SIGNED_BIGINT ||
    terminal.revisionSequence < 0n ||
    terminal.revisionSequence > MAX_SIGNED_BIGINT
  )
    throw new ProviderBudgetConfigurationError("Invalid fencing token");
  assertUsage(terminal.usage);
  if (
    terminal.observationComplete !== undefined &&
    terminal.usage?.observationComplete !== undefined &&
    terminal.observationComplete !== terminal.usage.observationComplete
  )
    throw new ProviderBudgetConfigurationError("Conflicting terminal observation completeness");
  const normalizedObservationComplete =
    terminal.observationComplete ?? terminal.usage?.observationComplete;
  const sourceVersion = normalizedVersion(
    terminal.sourceVersion ??
      (terminal.reason === "CRASH_RECOVERY" ? "crash-recovery-v1" : "terminal-v1"),
    "sourceVersion",
  );
  const usageSource = normalizedVersion(
    terminal.usageSource ?? (terminal.reason === "CRASH_RECOVERY" ? "crash-repair" : "terminal"),
    "usageSource",
  );
  await serializedByAdvisoryLocks(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-budget-attempt:${terminal.attemptId}`}, 0))`;
    await tx.$queryRaw`SELECT id FROM provider_attempt WHERE "attemptId" = ${terminal.attemptId} AND "fencingToken" = ${terminal.fencingToken} FOR UPDATE`;
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
      terminal.reason === "CRASH_RECOVERY" &&
      terminal.crashExpiredAt &&
      anchor.expiresAt > terminal.crashExpiredAt
    )
      return;
    if (
      anchor.userId !== terminal.userId ||
      anchor.providerAccountId !== terminal.providerAccountId ||
      anchor.providerModelId !== terminal.providerModelId ||
      anchor.poolId !== (terminal.poolId ?? null) ||
      anchor.credentialId !== (terminal.credentialId ?? null) ||
      anchor.requestId !== terminal.requestId
    )
      throw new ProviderBudgetConfigurationError("Terminal attempt identity conflict");

    const expireCrashAnchor = async () => {
      if (terminal.reason !== "CRASH_RECOVERY") return;
      const terminalAt = new Date();
      await tx.providerAttempt.updateMany({
        where: { id: anchor.id, state: "ACTIVE" },
        data: {
          state: "EXPIRED",
          terminalAt,
          terminalReason: "CRASH_RECOVERY",
          heartbeatAt: terminalAt,
        },
      });
    };
    const finalizeNonCrashAnchor = async () => {
      if (terminal.reason === "CRASH_RECOVERY" || anchor.state !== "ACTIVE") return;
      const terminalAt = new Date();
      const finalized = await tx.providerAttempt.updateMany({
        where: { id: anchor.id, state: "ACTIVE" },
        data: {
          state:
            terminal.reason === "COMPLETED"
              ? "COMPLETED"
              : terminal.reason === "CANCELLED"
                ? "CANCELLED"
                : "FAILED",
          terminalReason: terminal.reason,
          terminalAt,
          heartbeatAt: terminalAt,
        },
      });
      if (finalized.count !== 1)
        throw new ProviderBudgetConfigurationError(
          "Provider attempt was not active at terminal settlement",
        );
    };

    const usage = terminal.usage;
    const observationComplete = normalizedObservationComplete;
    const sourceUsageAccountingVersion = usage
      ? normalizedVersion(usage.accountingVersion, "accountingVersion")
      : undefined;
    const billableTotal = usage && providerBillableTokens(usage);
    const accountingMatches = usage?.accountingVersion.trim() === anchor.accountingVersion;
    const payloadHash = terminalPayloadHash(
      terminal,
      sourceVersion,
      usageSource,
      accountingMatches,
      observationComplete,
    );
    const priorRevision = await tx.providerUsageLedger.findUnique({
      where: {
        attemptId_fencingToken_sourceVersion: {
          attemptId: terminal.attemptId,
          fencingToken: terminal.fencingToken,
          sourceVersion,
        },
      },
      select: { payloadHash: true, revisionSequence: true, revisionKind: true },
    });
    if (priorRevision) {
      if (
        priorRevision.payloadHash !== payloadHash ||
        priorRevision.revisionSequence !== terminal.revisionSequence ||
        priorRevision.revisionKind !== terminal.revisionKind
      )
        throw new ProviderBudgetConfigurationError("Accounting source revision conflict");
      await finalizeNonCrashAnchor();
      await expireCrashAnchor();
      return;
    }
    const previousLedgers = await tx.providerUsageLedger.findMany({
      where: { attemptId: terminal.attemptId, fencingToken: terminal.fencingToken },
      orderBy: { revisionSequence: "desc" },
      select: { revisionSequence: true },
    });
    // A completed terminal observation always wins a crash sweep that selected
    // the row just before the terminal transaction committed.
    if (terminal.reason === "CRASH_RECOVERY" && previousLedgers.length > 0) return;
    if (previousLedgers[0] && terminal.revisionSequence <= previousLedgers[0].revisionSequence)
      throw new ProviderBudgetConfigurationError("Stale accounting revision");

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

    const reportedCurrency = normalizedCurrency(usage?.reportedCostCurrency ?? usage?.currency);
    const reportedPricingVersion =
      usage?.reportedCostPricingVersion?.trim() ?? usage?.pricingVersion?.trim();
    const calculatedCurrency = normalizedCurrency(usage?.calculatedCostCurrency ?? usage?.currency);
    const calculatedPricingVersion =
      usage?.calculatedCostPricingVersion?.trim() ?? usage?.pricingVersion?.trim();
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
    // Cost and token observations from an incomplete stream remain useful
    // evidence, but cannot safely reduce the admitted liability.
    // Cost provenance is independent when completeness is unspecified: some
    // non-streaming providers report an authoritative charge without a full
    // token-category breakdown. An explicit false, however, marks a truncated
    // observation and must retain the conservative admitted liability.
    const costKnown = suppliedCost !== undefined && observationComplete === true;
    const suppliedCostConfidence: UsageConfidence = reportedMatches
      ? "REPORTED"
      : calculatedMatches
        ? (usage?.calculatedCostConfidence ?? "CALCULATED")
        : "ESTIMATED";
    const settledCost = costKnown ? decimal(suppliedCost) : null;

    for (const reservation of reservations) {
      const trustworthy =
        reservation.metric === "CONCURRENCY" ||
        (reservation.metric === "TOKENS" &&
          accountingMatches &&
          observationComplete === true &&
          billableTotal !== undefined) ||
        (reservation.metric === "SPEND" && costKnown);
      const prior = await tx.providerBudgetSettlement.aggregate({
        where: { reservationId: reservation.id },
        _sum: { settledValue: true },
      });
      const priorTotal = prior._sum.settledValue ?? new Prisma.Decimal(0);
      const observation = trustworthy
        ? reservation.metric === "SPEND" && settledCost
          ? settledCost
          : terminalValue(reservation.metric, usage)
        : reservation.reservedValue;
      const delta =
        terminal.revisionKind === "SNAPSHOT"
          ? observation.minus(priorTotal)
          : trustworthy
            ? observation
            : priorTotal.lessThan(reservation.reservedValue)
              ? reservation.reservedValue.minus(priorTotal)
              : new Prisma.Decimal(0);
      const desiredTotal = priorTotal.plus(delta);
      if (desiredTotal.isNegative())
        throw new ProviderBudgetConfigurationError("Accounting correction underflows zero");
      await tx.providerBudgetSettlement.create({
        data: {
          userId: terminal.userId,
          providerAccountId: anchor.providerAccountId,
          providerModelId: anchor.providerModelId,
          credentialId: anchor.credentialId,
          poolId: anchor.poolId,
          requestId: anchor.requestId,
          reservationId: reservation.id,
          attemptId: terminal.attemptId,
          fencingToken: terminal.fencingToken,
          sourceVersion,
          revisionSequence: terminal.revisionSequence,
          revisionKind: terminal.revisionKind,
          payloadHash,
          sourceUsageAccountingVersion,
          accountingVersion: anchor.accountingVersion,
          pricingVersion: anchor.pricingVersion,
          settledValue: delta,
          currency: reservation.metric === "SPEND" ? reservation.currency : null,
          confidence:
            trustworthy && reservation.metric === "SPEND"
              ? suppliedCostConfidence
              : trustworthy
                ? (usage?.confidence ?? "ESTIMATED")
                : "ESTIMATED",
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
        reportedTotalTokens: usage?.reportedTotalTokens,
        billableTotal: accountingMatches ? billableTotal : undefined,
        categoriesComplete: usage?.categoriesComplete,
        observationComplete,
        rawUsage: usage?.rawUsage,
        reportedCost: usage?.reportedCost,
        reportedCostCurrency: reportedCurrency,
        reportedCostPricingVersion: reportedPricingVersion,
        reportedCostSource:
          usage?.reportedCost === undefined
            ? undefined
            : normalizedVersion(usage.reportedCostSource ?? usageSource, "reportedCostSource"),
        calculatedCost: usage?.calculatedCost,
        calculatedCostCurrency: calculatedCurrency,
        calculatedCostPricingVersion: calculatedPricingVersion,
        calculatedCostSource:
          usage?.calculatedCost === undefined
            ? undefined
            : normalizedVersion(usage.calculatedCostSource ?? usageSource, "calculatedCostSource"),
        settledCost,
        currency: anchor.liabilityCurrency,
        pricingVersion: anchor.pricingVersion,
        sourceUsageAccountingVersion,
        accountingVersion: anchor.accountingVersion,
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
          ? suppliedCostConfidence
          : accountingMatches
            ? (usage?.confidence ?? "ESTIMATED")
            : "ESTIMATED",
      },
    });
    if (terminalPersistenceTestFailure?.() === "SIMULATE_LEGACY_SPLIT") return;
    await finalizeNonCrashAnchor();
    await expireCrashAnchor();
  });
}

/** Crash repair is conservative: expired liability is settled, never silently refunded. */
export async function repairExpiredProviderBudgets(
  now = new Date(),
  scope?: { userId: string; providerAccountId: string },
): Promise<number> {
  if (!Number.isFinite(now.getTime()))
    throw new ProviderBudgetConfigurationError("Invalid repair date");
  const expired = await prisma.$queryRaw<
    Array<{
      userId: string;
      providerAccountId: string;
      providerModelId: string;
      credentialId: string | null;
      poolId: string | null;
      requestId: string;
      attemptId: string;
      fencingToken: bigint;
      ledgerTerminalReason: string | null;
    }>
  >`SELECT a."userId", a."providerAccountId", a."providerModelId", a."credentialId",
           a."poolId", a."requestId", a."attemptId", a."fencingToken",
           (SELECT l."terminalReason" FROM provider_usage_ledger l
             WHERE l."attemptId" = a."attemptId" AND l."fencingToken" = a."fencingToken"
             ORDER BY l."revisionSequence" DESC, l."createdAt" DESC LIMIT 1) AS "ledgerTerminalReason"
     FROM provider_attempt a
     WHERE a.state = 'ACTIVE' AND a."expiresAt" <= ${now}
       AND (${scope?.userId ?? null}::text IS NULL OR a."userId" = ${scope?.userId ?? null})
       AND (${scope?.providerAccountId ?? null}::text IS NULL OR a."providerAccountId" = ${scope?.providerAccountId ?? null})
     ORDER BY a."attemptId"`;
  for (const row of expired) {
    if (row.ledgerTerminalReason) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-budget-attempt:${row.attemptId}`}, 0))`;
        const latest = await tx.providerUsageLedger.findFirst({
          where: { attemptId: row.attemptId, fencingToken: row.fencingToken },
          orderBy: [{ revisionSequence: "desc" }, { createdAt: "desc" }],
          select: { terminalReason: true },
        });
        if (!latest) return;
        const terminalAt = new Date();
        await tx.providerAttempt.updateMany({
          where: { attemptId: row.attemptId, fencingToken: row.fencingToken, state: "ACTIVE" },
          data: {
            state:
              latest.terminalReason === "COMPLETED"
                ? "COMPLETED"
                : latest.terminalReason === "CANCELLED"
                  ? "CANCELLED"
                  : latest.terminalReason === "CRASH_RECOVERY"
                    ? "EXPIRED"
                    : "FAILED",
            terminalReason: latest.terminalReason,
            terminalAt,
            heartbeatAt: terminalAt,
          },
        });
      });
      continue;
    }
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
      crashExpiredAt: now,
      revisionSequence: 0n,
      revisionKind: "SNAPSHOT",
    });
  }
  return expired.length;
}
