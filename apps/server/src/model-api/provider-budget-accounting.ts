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
  /** Provider aggregate retained as corroboration; never added to categories. */
  reportedTotalTokens?: bigint;
}

export function providerBillableTokens(usage: ProviderTokenUsage): bigint | undefined {
  if (usage.authoritativeBillableTokens !== undefined && usage.categoriesComplete !== false)
    return usage.authoritativeBillableTokens;
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
