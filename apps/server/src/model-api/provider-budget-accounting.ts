export interface ProviderTokenUsage {
  inputTokens?: bigint;
  outputTokens?: bigint;
  cacheReadTokens?: bigint;
  cacheWriteTokens?: bigint;
  reasoningTokens?: bigint;
  toolTokens?: bigint;
  /**
   * Prompt-side categories not represented above (input audio). Like the
   * output side below, priced at the schedule's single `additional` rate.
   */
  additionalInputTokens?: bigint;
  /** Completion-side categories not represented above (output audio, accepted/rejected predictions). */
  additionalOutputTokens?: bigint;
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
    usage.additionalInputTokens,
    usage.additionalOutputTokens,
  ];
  return categories.reduce<bigint>((sum, value) => sum + (value ?? 0n), 0n);
}

/** Both additional sides together (the priced `additional` category); absent when neither is known. */
export function additionalBillableTokens(
  usage: Pick<ProviderTokenUsage, "additionalInputTokens" | "additionalOutputTokens">,
): bigint | undefined {
  if (usage.additionalInputTokens === undefined && usage.additionalOutputTokens === undefined)
    return undefined;
  return (usage.additionalInputTokens ?? 0n) + (usage.additionalOutputTokens ?? 0n);
}
