export type ContextCountMethod =
  | "NATIVE"
  | "TOKENIZER_TEMPLATE"
  | "TOKEN_ESTIMATE"
  | "CHAR_ESTIMATE";
export type ContextCount = { tokens: number; method: ContextCountMethod; exact: boolean };
export type ContextCountTelemetry = ContextCount & {
  confidence: "EXACT" | "HIGH" | "CONSERVATIVE" | "FALLBACK";
  safetyMargin: number;
  serializedChars: number;
};

export interface ContextCounter {
  count(input: unknown, signal?: AbortSignal): Promise<ContextCount | null>;
}

export async function countSerializedRequestContext({
  input,
  counters = [],
  safetyMargin = 1.2,
  signal,
}: {
  input: unknown;
  counters?: readonly ContextCounter[];
  safetyMargin?: number;
  signal?: AbortSignal;
}): Promise<ContextCountTelemetry> {
  if (signal?.aborted) throw signal.reason;
  const serialized = JSON.stringify(input);
  if (serialized === undefined) throw new TypeError("Context input must be JSON serializable.");
  const result = await countContext({
    input,
    counters,
    serializedChars: serialized.length,
    safetyMargin,
    signal,
  });
  return {
    ...result,
    confidence: result.exact
      ? "EXACT"
      : result.method === "TOKENIZER_TEMPLATE"
        ? "HIGH"
        : result.method === "TOKEN_ESTIMATE"
          ? "CONSERVATIVE"
          : "FALLBACK",
    safetyMargin: result.method === "CHAR_ESTIMATE" ? safetyMargin : 1,
    serializedChars: serialized.length,
  };
}

export function contextFitsLimits({
  count,
  physicalMaxContext,
  effectiveContextCeiling,
  contextMargin = 0,
}: {
  count: ContextCount;
  physicalMaxContext?: number | null;
  effectiveContextCeiling?: number | null;
  contextMargin?: number;
}): boolean {
  if (!Number.isSafeInteger(contextMargin) || contextMargin < 0)
    throw new RangeError("Context margin must be a nonnegative safe integer.");
  const limits = [physicalMaxContext, effectiveContextCeiling].filter(
    (limit): limit is number => limit !== null && limit !== undefined,
  );
  for (const limit of limits) {
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw new RangeError("Context ceilings must be positive safe integers.");
  }
  const ceiling = limits.length ? Math.min(...limits) : null;
  return ceiling === null || count.tokens + contextMargin <= ceiling;
}

export async function countContext({
  input,
  counters,
  serializedChars,
  safetyMargin = 1.2,
  signal,
}: {
  input: unknown;
  counters: readonly ContextCounter[];
  serializedChars: number;
  safetyMargin?: number;
  signal?: AbortSignal;
}): Promise<ContextCount> {
  for (const counter of counters) {
    if (signal?.aborted) throw signal.reason;
    const result = await counter.count(input, signal);
    if (signal?.aborted) throw signal.reason;
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
