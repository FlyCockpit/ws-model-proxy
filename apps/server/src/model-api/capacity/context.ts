export type ContextCountMethod =
  | "NATIVE"
  | "TOKENIZER_TEMPLATE"
  | "TOKEN_ESTIMATE"
  | "CHAR_ESTIMATE";
export type ContextCount = { tokens: number; method: ContextCountMethod; exact: boolean };

export interface ContextCounter {
  count(input: unknown, signal?: AbortSignal): Promise<ContextCount | null>;
}

export async function countContext({
  input,
  counters,
  serializedChars,
  safetyMargin = 1.2,
}: {
  input: unknown;
  counters: readonly ContextCounter[];
  serializedChars: number;
  safetyMargin?: number;
}): Promise<ContextCount> {
  for (const counter of counters) {
    const result = await counter.count(input);
    if (result) return validateCount(result);
  }
  if (!Number.isSafeInteger(serializedChars) || serializedChars < 0)
    throw new RangeError("serializedChars must be a nonnegative safe integer.");
  if (!Number.isFinite(safetyMargin) || safetyMargin < 1)
    throw new RangeError("safetyMargin must be at least one.");
  return {
    tokens: Math.ceil((serializedChars / 4) * safetyMargin),
    method: "CHAR_ESTIMATE",
    exact: false,
  };
}

function validateCount(count: ContextCount): ContextCount {
  if (!Number.isSafeInteger(count.tokens) || count.tokens < 0)
    throw new RangeError("Context token count must be a nonnegative safe integer.");
  if (count.exact && count.method !== "NATIVE")
    throw new Error("Only native counts may be marked exact.");
  return count;
}
