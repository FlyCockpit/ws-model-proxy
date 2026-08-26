import prisma, { Prisma } from "@ws-model-proxy/db";
import type { ProviderLiability, RawProviderUsage, UsageConfidence } from "./provider-budget.js";

const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;

export interface ProviderPricingSchedule {
  id: string;
  version: string;
  currency: string;
  accountingVersion: string;
  confidence: UsageConfidence;
  effectiveAt: Date;
  rates: Record<"input" | "output", Prisma.Decimal> &
    Partial<
      Record<"cacheRead" | "cacheWrite" | "reasoning" | "tool" | "additional", Prisma.Decimal>
    >;
  rules: {
    inputIncludesCacheRead: boolean;
    inputIncludesCacheWrite: boolean;
    outputIncludesReasoning: boolean;
    outputIncludesTool: boolean;
    reasoningAllowanceTokens: bigint;
    toolAllowanceTokens: bigint;
    cacheReadAllowanceTokens: bigint;
    cacheWriteAllowanceTokens: bigint;
    additionalAllowanceTokens: bigint;
    unknownCategories: "FAIL_CLOSED";
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function decimalRate(value: unknown): Prisma.Decimal | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const result = new Prisma.Decimal(value);
  return result.isFinite() && !result.isNegative() ? result : undefined;
}

function allowance(value: unknown): bigint | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? BigInt(value)
    : undefined;
}

export function parsePricingSchedule(row: {
  id: string;
  version: string;
  currency: string;
  accountingVersion: string;
  confidence: UsageConfidence;
  effectiveAt: Date;
  pricing: unknown;
  chargeRules: unknown;
}): ProviderPricingSchedule | undefined {
  const ratesValue = record(record(row.pricing)?.ratesPerMillion);
  const rulesValue = record(row.chargeRules);
  if (!ratesValue || !rulesValue || rulesValue.unknownCategories !== "FAIL_CLOSED")
    return undefined;
  const input = decimalRate(ratesValue.input);
  const output = decimalRate(ratesValue.output);
  const cacheReadAllowanceTokens = allowance(rulesValue.cacheReadAllowanceTokens);
  const cacheWriteAllowanceTokens = allowance(rulesValue.cacheWriteAllowanceTokens);
  const reasoningAllowanceTokens = allowance(rulesValue.reasoningAllowanceTokens);
  const toolAllowanceTokens = allowance(rulesValue.toolAllowanceTokens);
  const additionalAllowanceTokens = allowance(rulesValue.additionalAllowanceTokens);
  if (
    !input ||
    !output ||
    !/^[A-Z]{3}$/u.test(row.currency) ||
    cacheReadAllowanceTokens === undefined ||
    cacheWriteAllowanceTokens === undefined ||
    reasoningAllowanceTokens === undefined ||
    toolAllowanceTokens === undefined ||
    additionalAllowanceTokens === undefined
  )
    return undefined;
  const rates: ProviderPricingSchedule["rates"] = { input, output };
  for (const key of ["cacheRead", "cacheWrite", "reasoning", "tool", "additional"] as const) {
    const parsed = decimalRate(ratesValue[key]);
    if (parsed) rates[key] = parsed;
  }
  return {
    id: row.id,
    version: row.version,
    currency: row.currency,
    accountingVersion: row.accountingVersion,
    // The schedule is local pricing provenance, never a provider-reported cost.
    confidence: row.confidence === "REPORTED" ? "CALCULATED" : row.confidence,
    effectiveAt: row.effectiveAt,
    rates,
    rules: {
      inputIncludesCacheRead: rulesValue.inputIncludesCacheRead === true,
      inputIncludesCacheWrite: rulesValue.inputIncludesCacheWrite === true,
      outputIncludesReasoning: rulesValue.outputIncludesReasoning === true,
      outputIncludesTool: rulesValue.outputIncludesTool === true,
      cacheReadAllowanceTokens,
      cacheWriteAllowanceTokens,
      reasoningAllowanceTokens,
      toolAllowanceTokens,
      additionalAllowanceTokens,
      unknownCategories: "FAIL_CLOSED",
    },
  };
}

export async function resolveActiveProviderPricing(input: {
  userId: string;
  providerAccountId: string;
  providerModelId: string;
  at?: Date;
}): Promise<ProviderPricingSchedule | undefined> {
  const at = input.at ?? new Date();
  const row = await prisma.providerPricingVersion.findFirst({
    where: {
      userId: input.userId,
      providerAccountId: input.providerAccountId,
      providerModelId: input.providerModelId,
      status: { in: ["ACTIVE", "RETIRED"] },
      effectiveAt: { lte: at },
      OR: [{ retiredAt: null }, { retiredAt: { gt: at } }],
    },
    orderBy: [{ effectiveAt: "desc" }, { createdAt: "desc" }],
  });
  return row ? parsePricingSchedule(row) : undefined;
}

function checkedTotal(values: readonly bigint[]): bigint | undefined {
  const total = values.reduce((sum, value) => sum + value, 0n);
  return total <= MAX_SIGNED_BIGINT ? total : undefined;
}

export function liabilityFromPricing(input: {
  estimatedInputTokens: bigint;
  requestedOutputTokens: bigint;
  pricing?: ProviderPricingSchedule;
}): ProviderLiability {
  // A generic serialized-token estimate is suitable for a context ceiling,
  // but is not a provider-billable liability without a safe pricing/accounting
  // schedule. Unlimited policies may still dispatch with this liability absent.
  if (!input.pricing) return { accountingVersion: "provider-billable-v1" };
  const cacheRead = input.pricing.rules.cacheReadAllowanceTokens;
  const cacheWrite = input.pricing.rules.cacheWriteAllowanceTokens;
  const reasoning = input.pricing.rules.reasoningAllowanceTokens;
  const tool = input.pricing.rules.toolAllowanceTokens;
  const additional = input.pricing.rules.additionalAllowanceTokens;
  const tokens = checkedTotal([
    input.estimatedInputTokens,
    input.requestedOutputTokens,
    reasoning,
    tool,
    cacheRead,
    cacheWrite,
    additional,
  ]);
  const canPriceCategory = (bound: bigint, included: boolean, rate: Prisma.Decimal | undefined) =>
    bound === 0n || included || rate !== undefined;
  if (
    !canPriceCategory(
      cacheRead,
      input.pricing.rules.inputIncludesCacheRead,
      input.pricing.rates.cacheRead,
    ) ||
    !canPriceCategory(
      cacheWrite,
      input.pricing.rules.inputIncludesCacheWrite,
      input.pricing.rates.cacheWrite,
    ) ||
    !canPriceCategory(
      reasoning,
      input.pricing.rules.outputIncludesReasoning,
      input.pricing.rates.reasoning,
    ) ||
    !canPriceCategory(tool, input.pricing.rules.outputIncludesTool, input.pricing.rates.tool) ||
    (additional > 0n && input.pricing.rates.additional === undefined)
  )
    return {
      tokens,
      currency: input.pricing.currency,
      pricingVersion: input.pricing.version,
      accountingVersion: input.pricing.accountingVersion,
    };
  const spend = input.pricing.rates.input
    .mul(input.estimatedInputTokens.toString())
    .plus(input.pricing.rates.output.mul(input.requestedOutputTokens.toString()))
    .plus((input.pricing.rates.reasoning ?? input.pricing.rates.output).mul(reasoning.toString()))
    .plus((input.pricing.rates.tool ?? input.pricing.rates.output).mul(tool.toString()))
    .plus(
      (input.pricing.rules.inputIncludesCacheRead
        ? input.pricing.rates.input
        : (input.pricing.rates.cacheRead ?? input.pricing.rates.input)
      ).mul(cacheRead.toString()),
    )
    .plus(
      (input.pricing.rules.inputIncludesCacheWrite
        ? input.pricing.rates.input
        : (input.pricing.rates.cacheWrite ?? input.pricing.rates.input)
      ).mul(cacheWrite.toString()),
    )
    .plus((input.pricing.rates.additional ?? input.pricing.rates.output).mul(additional.toString()))
    .div(1_000_000);
  return {
    tokens,
    spend,
    currency: input.pricing.currency,
    pricingVersion: input.pricing.version,
    accountingVersion: input.pricing.accountingVersion,
  };
}

export function calculatedCostForUsage(
  usage: RawProviderUsage,
  pricing: ProviderPricingSchedule,
): Prisma.Decimal | undefined {
  if (usage.authoritativeBillableTokens !== undefined) return undefined;
  if (usage.categoriesComplete !== true) return undefined;
  const input = usage.inputTokens ?? 0n;
  const output = usage.outputTokens ?? 0n;
  const cacheRead = usage.cacheReadTokens ?? 0n;
  const cacheWrite = usage.cacheWriteTokens ?? 0n;
  const reasoning = usage.reasoningTokens ?? 0n;
  const tool = usage.toolTokens ?? 0n;
  const additional = usage.additionalBillableTokens ?? 0n;
  const charge = (tokens: bigint, rate: Prisma.Decimal) => rate.mul(tokens.toString());
  let total = charge(input, pricing.rates.input).plus(charge(output, pricing.rates.output));
  const cacheReadRate = pricing.rules.inputIncludesCacheRead
    ? pricing.rates.input
    : pricing.rates.cacheRead;
  if (cacheRead > 0n && !cacheReadRate) return undefined;
  if (cacheReadRate) total = total.plus(charge(cacheRead, cacheReadRate));
  const cacheWriteRate = pricing.rules.inputIncludesCacheWrite
    ? pricing.rates.input
    : pricing.rates.cacheWrite;
  if (cacheWrite > 0n && !cacheWriteRate) return undefined;
  if (cacheWriteRate) total = total.plus(charge(cacheWrite, cacheWriteRate));
  const reasoningRate = pricing.rules.outputIncludesReasoning
    ? pricing.rates.output
    : pricing.rates.reasoning;
  if (reasoning > 0n && !reasoningRate) return undefined;
  if (reasoningRate) total = total.plus(charge(reasoning, reasoningRate));
  const toolRate = pricing.rules.outputIncludesTool ? pricing.rates.output : pricing.rates.tool;
  if (tool > 0n && !toolRate) return undefined;
  if (toolRate) total = total.plus(charge(tool, toolRate));
  if (additional > 0n && !pricing.rates.additional) return undefined;
  if (pricing.rates.additional) total = total.plus(charge(additional, pricing.rates.additional));
  return total.div(1_000_000);
}
