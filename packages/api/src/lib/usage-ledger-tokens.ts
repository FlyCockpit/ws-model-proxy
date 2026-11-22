/**
 * Prompt and completion totals of one `usage_ledger` row.
 *
 * The ledger stores every billable category apart from the provider's own
 * counts (input exclusive of cache and audio tokens, output exclusive of
 * reasoning, audio and prediction tokens), so a view adds each side's
 * categories back. Every category belongs to exactly one side; the sides
 * together equal the row's billable total.
 */

export type UsageLedgerTokenRow = {
  inputTokens: bigint | null;
  outputTokens: bigint | null;
  cacheReadTokens: bigint | null;
  cacheWriteTokens: bigint | null;
  reasoningTokens: bigint | null;
  toolTokens: bigint | null;
  additionalBillableTokens: bigint | null;
  additionalInputTokens: bigint | null;
  additionalOutputTokens: bigint | null;
  rawUsage: unknown;
};

function tokenSum(...parts: Array<bigint | null>): number | null {
  const known = parts.filter((part): part is bigint => typeof part === "bigint");
  if (known.length === 0) return null;
  return Number(known.reduce((sum, part) => sum + part, 0n));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function count(value: unknown): bigint | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? BigInt(value)
    : undefined;
}

/** The usage observations a row's `rawUsage` holds, in order (merges nest them in arrays). */
function observations(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw.flatMap(observations);
  const usage = record(raw);
  return usage ? [usage] : [];
}

/**
 * Input side of a row written before the split, which stored only the mixed
 * `additionalBillableTokens` total. The observations in `rawUsage` are the
 * candidates (stored de-duplicated, so their order does not say which one
 * supplied the total): one counts when the mixed total it yields equals the
 * stored one and it has a prompt count that equals the row's prompt
 * categories plus its input audio. The input side is the audio count the
 * candidates agree on; with none, or a disagreement, it is zero, and the
 * whole total counts as output (nothing is lost from the row's sum).
 */
function legacyAdditionalInput(row: UsageLedgerTokenRow, total: bigint): bigint {
  const input = row.inputTokens ?? 0n;
  const cacheRead = row.cacheReadTokens ?? 0n;
  const cacheWrite = row.cacheWriteTokens ?? 0n;
  const agreed = new Set<bigint>();
  for (const usage of observations(row.rawUsage)) {
    const prompt = record(usage.prompt_tokens_details ?? usage.input_tokens_details);
    const completion = record(usage.completion_tokens_details ?? usage.output_tokens_details);
    // The mixed total the normalizer then derived from this observation: input and output
    // audio, accepted and rejected predictions, and the undirected key it still accepted.
    const audio = count(prompt?.audio_tokens);
    const parts = [
      audio,
      count(completion?.audio_tokens),
      count(completion?.accepted_prediction_tokens),
      count(completion?.rejected_prediction_tokens),
      count(usage.additional_billable_tokens),
    ];
    if (parts.every((part) => part === undefined)) continue;
    if (parts.reduce<bigint>((sum, part) => sum + (part ?? 0n), 0n) !== total) continue;
    const side = audio ?? 0n;
    // The normalizer's alias precedence (`input_tokens` first).
    const promptTotal = count(usage.input_tokens ?? usage.prompt_tokens);
    // OpenAI counts cache writes inside the prompt only on OpenRouter; either form fits.
    if (
      promptTotal === undefined ||
      (promptTotal !== input + cacheRead + side &&
        promptTotal !== input + cacheRead + cacheWrite + side)
    )
      continue;
    agreed.add(side);
  }
  const [only] = agreed;
  return agreed.size === 1 && only !== undefined ? only : 0n;
}

function additionalSides(row: UsageLedgerTokenRow): {
  input: bigint | null;
  output: bigint | null;
} {
  if (row.additionalInputTokens != null || row.additionalOutputTokens != null)
    return { input: row.additionalInputTokens, output: row.additionalOutputTokens };
  const total = row.additionalBillableTokens;
  if (total == null) return { input: null, output: null };
  const input = legacyAdditionalInput(row, total);
  return { input, output: total - input };
}

/**
 * A side's total: null when none of its own categories is known. An
 * observation that reported only the other side's additional tokens still
 * records this side's additional count (as zero), which is no count of this side.
 */
function sideTotal(parts: Array<bigint | null>, additional: bigint | null): number | null {
  if (tokenSum(...parts) === null) return null;
  return tokenSum(...parts, additional);
}

export function usageLedgerTokenTotals(row: UsageLedgerTokenRow): {
  inputTokens: number | null;
  outputTokens: number | null;
} {
  const additional = additionalSides(row);
  return {
    inputTokens: sideTotal(
      [row.inputTokens, row.cacheReadTokens, row.cacheWriteTokens],
      additional.input,
    ),
    outputTokens: sideTotal(
      [row.outputTokens, row.reasoningTokens, row.toolTokens],
      additional.output,
    ),
  };
}
