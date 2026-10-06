/**
 * Cloud spend admission and accounting (spend caps, spec §2.7; lanes B3/B4 implement it on
 * SpendCap / SpendReservation / SpendSettlement / UsageLedger with the `spend-attempt` and
 * `spend-cap` fences).
 *
 * S0: the 0.3 budget-policy engine is gone with its tables. Until B3/B4 land this module FAILS
 * CLOSED: no cloud attempt is admitted (`SPEND_UNAVAILABLE`), so no provider request can spend
 * money without a reservation. The types are the contract the attempt pipeline keeps.
 */
import { Prisma } from "@ws-model-proxy/db";
import type { ProviderTokenUsage } from "./provider-budget-accounting.js";

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
  userId: string;
  providerAccountId: string;
  providerModelId: string;
  credentialId?: string;
  poolId?: string;
  /** The share owner-paid grantee traffic runs under (its cap applies); never own-key or owner. */
  shareId?: string;
  /** The share's grantee; spend is summed per share. */
  granteeUserId?: string;
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
        | "GRANTEE_BUDGET_EXCEEDED"
        | "GRANTEE_CAP_UNPRICEABLE"
        | "PROVIDER_CONCURRENCY_EXCEEDED"
        | "PROTECTION_POLICY_MISSING"
        | "CURRENCY_UNAVAILABLE"
        | "PRICING_UNAVAILABLE"
        | "TOKEN_BOUND_UNAVAILABLE"
        /** S0: spend caps are not wired yet (lanes B3/B4); every cloud attempt is refused. */
        | "SPEND_UNAVAILABLE";
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
  /** Explicit proof that provider I/O never began. Omission conservatively assumes it may have. */
  dispatchOutcome?: "NOT_SENT";
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

/**
 * Admission of one cloud attempt against every cap that applies (the provider account's and,
 * for owner-paid share traffic, the share's). S0: validates the attempt and refuses it.
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
  normalizedVersion(attempt.liability.accountingVersion, "accountingVersion");
  normalizedCurrency(attempt.liability.currency);
  if (attempt.liability.spend !== undefined) decimal(attempt.liability.spend);
  return { admitted: false, reason: "SPEND_UNAVAILABLE" };
}

/**
 * Appends one accounting revision for an admitted attempt. S0 admits nothing, so there is
 * nothing to settle; the input is still validated so callers stay honest.
 */
export async function reconcileProviderBudget(terminal: ProviderBudgetTerminal): Promise<void> {
  if (
    terminal.fencingToken <= 0n ||
    terminal.fencingToken > MAX_SIGNED_BIGINT ||
    terminal.revisionSequence < 0n ||
    terminal.revisionSequence > MAX_SIGNED_BIGINT
  )
    throw new ProviderBudgetConfigurationError("Invalid fencing token");
  assertUsage(terminal.usage);
}

/** Crash repair of expired cloud attempts (B4). S0: nothing is ever reserved. */
export async function repairExpiredProviderBudgets(
  now = new Date(),
  _scope?: { userId: string; providerAccountId: string },
): Promise<number> {
  if (!Number.isFinite(now.getTime()))
    throw new ProviderBudgetConfigurationError("Invalid repair date");
  return 0;
}

export type { ProviderTokenUsage };
