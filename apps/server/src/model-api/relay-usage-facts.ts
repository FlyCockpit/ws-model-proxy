/**
 * Server-side, prompt-free token usage facts for a relayed request.
 *
 * Usage is parsed ONCE at finalization from the bounded response windows the
 * relay executor retains for every attempt, using the shared provider usage
 * normalizer (`parseProviderUsage` / `mergeProviderUsage`). That normalizer
 * understands both OpenAI (`prompt_tokens`, `prompt_tokens_details`) and
 * Anthropic (`input_tokens`, `cache_read_input_tokens`,
 * `cache_creation_input_tokens`) shapes, so Anthropic-kind endpoints report
 * usage even though the CLI's own normalized usage lacks the `input_tokens`
 * alias. CLI-normalized usage remains a fallback when the body carried none.
 */

import type { RawProviderUsage } from "./provider-budget.js";
import { mergeProviderUsage, parseProviderUsage } from "./public-overflow.js";
import { type ResponseUsageSample, USAGE_SAMPLE_TAIL_BYTES } from "./response-usage-sample.js";

export type RelayUsageFacts = {
  /** Total prompt tokens: uncached input + cache reads + cache writes. */
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  /** Null when the upstream did not report prompt-cache reads. */
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  usageKnown: boolean;
};

export const UNKNOWN_USAGE_FACTS: RelayUsageFacts = {
  promptTokens: null,
  completionTokens: null,
  totalTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  usageKnown: false,
};

const INT32_MAX = 2_147_483_647;

function toInt(value: bigint | number | undefined | null): number | null {
  if (value === undefined || value === null) return null;
  const numeric = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.min(INT32_MAX, Math.trunc(numeric));
}

function sum(...values: Array<number | null>): number | null {
  if (values.every((value) => value === null)) return null;
  return Math.min(
    INT32_MAX,
    values.reduce<number>((total, value) => total + (value ?? 0), 0),
  );
}

/** Normalizes a parsed provider usage observation into relay usage facts. */
export function usageFactsFromProviderUsage(
  usage:
    | Pick<
        RawProviderUsage,
        | "inputTokens"
        | "outputTokens"
        | "cacheReadTokens"
        | "cacheWriteTokens"
        | "reasoningTokens"
        | "reportedTotalTokens"
      >
    | null
    | undefined,
): RelayUsageFacts {
  if (!usage) return UNKNOWN_USAGE_FACTS;
  const input = toInt(usage.inputTokens);
  const output = toInt(usage.outputTokens);
  const cacheRead = toInt(usage.cacheReadTokens);
  const cacheWrite = toInt(usage.cacheWriteTokens);
  const reasoning = toInt(usage.reasoningTokens);
  // The normalizer reports OpenAI input exclusive of cached tokens and
  // Anthropic input exclusive of cache reads/writes; adding them back yields
  // the total prompt size used as the cache hit-rate denominator.
  const promptTokens = input === null ? null : sum(input, cacheRead, cacheWrite);
  const completionTokens = output === null ? null : sum(output, reasoning);
  const reportedTotal = toInt(usage.reportedTotalTokens);
  const usageKnown = promptTokens !== null || completionTokens !== null;
  return {
    promptTokens,
    completionTokens,
    totalTokens:
      reportedTotal ??
      (promptTokens === null && completionTokens === null
        ? null
        : sum(promptTokens, completionTokens)),
    cacheReadTokens: usageKnown ? cacheRead : null,
    cacheWriteTokens: usageKnown ? cacheWrite : null,
    usageKnown,
  };
}

function parsedSampleUsage(sample: ResponseUsageSample): RawProviderUsage | undefined {
  if (sample.totalBytes <= USAGE_SAMPLE_TAIL_BYTES) return parseProviderUsage(sample.tail);
  return mergeProviderUsage(parseProviderUsage(sample.prefix), parseProviderUsage(sample.tail));
}

/**
 * Parses the retained response windows; falls back to the CLI-normalized
 * usage when the body carried no recognizable usage. Never throws.
 */
export function usageFactsFromRelayTerminal(terminal: {
  usageSample?: ResponseUsageSample | null;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | null;
}): RelayUsageFacts {
  let parsed: RelayUsageFacts = UNKNOWN_USAGE_FACTS;
  if (terminal.usageSample && terminal.usageSample.totalBytes > 0) {
    try {
      parsed = usageFactsFromProviderUsage(parsedSampleUsage(terminal.usageSample));
    } catch {
      parsed = UNKNOWN_USAGE_FACTS;
    }
  }
  if (parsed.usageKnown) return parsed;
  const fallback = terminal.usage;
  if (!fallback) return parsed;
  const promptTokens = toInt(fallback.promptTokens);
  const completionTokens = toInt(fallback.completionTokens);
  const totalTokens = toInt(fallback.totalTokens);
  const usageKnown = promptTokens !== null || completionTokens !== null;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    usageKnown,
  };
}

/**
 * Engine prompt-cache evidence for affinity from already-parsed facts: true
 * when the upstream reported cache reads, false when it reported zero, and
 * undefined when it reported none (unknown, not a miss).
 */
export function engineCacheConfirmedFromUsageFacts(facts: RelayUsageFacts): boolean | undefined {
  return facts.cacheReadTokens === null ? undefined : facts.cacheReadTokens > 0;
}
