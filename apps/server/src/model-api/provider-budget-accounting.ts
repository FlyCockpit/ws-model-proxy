export type BudgetPeriod = "PER_ATTEMPT" | "UTC_DAY" | "UTC_MONTH" | "LIFETIME";

export interface ProviderTokenUsage {
  inputTokens?: bigint;
  outputTokens?: bigint;
  cacheReadTokens?: bigint;
  cacheWriteTokens?: bigint;
  reasoningTokens?: bigint;
  toolTokens?: bigint;
  /** Only categories not already represented by the fields above. */
  additionalBillableTokens?: bigint;
  /** True only when every provider-billable category is represented above. */
  categoriesComplete?: boolean;
  /** Provider-authoritative total. It is used instead of, never added to, categories. */
  authoritativeBillableTokens?: bigint;
}

export function budgetWindow(
  period: BudgetPeriod,
  activatedAt: Date,
  now: Date,
): { windowStart: Date | null; windowEnd: Date | null } {
  if (period === "PER_ATTEMPT") return { windowStart: null, windowEnd: null };
  if (period === "LIFETIME") return { windowStart: activatedAt, windowEnd: null };
  if (period === "UTC_DAY") {
    const windowStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    return { windowStart, windowEnd: new Date(windowStart.getTime() + 86_400_000) };
  }
  const windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return {
    windowStart,
    windowEnd: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

export function providerBillableTokens(usage: ProviderTokenUsage): bigint | undefined {
  if (usage.authoritativeBillableTokens !== undefined) return usage.authoritativeBillableTokens;
  if (usage.categoriesComplete !== true) return undefined;
  const categories = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    usage.reasoningTokens,
    usage.toolTokens,
    usage.additionalBillableTokens,
  ];
  return categories.reduce<bigint>((sum, value) => sum + (value ?? 0n), 0n);
}
