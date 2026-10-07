/**
 * The billable bound of the exact body a cloud attempt sends (Codex finding 3).
 *
 * A spend reservation priced for one completion of the request's `max_tokens` is not a bound
 * when the body asks the provider for several candidates (`n`, `best_of`, ...) or names a larger
 * output limit under another field: the provider bills every candidate. The bound is read from
 * the bytes that go upstream (native forwarding and rendered bodies alike), so no field the
 * provider honours is left out. A candidate or output field that is present but not a
 * non-negative safe integer cannot be bounded and the attempt is not sent.
 */
import { Prisma } from "@ws-model-proxy/db";
import type { ProviderLiability } from "./provider-budget.js";

/** Output-token limits (per candidate) across OpenAI, Anthropic and compatible servers. */
const OUTPUT_LIMIT_FIELDS = [
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "maxOutputTokens",
  "max_new_tokens",
] as const;
/** Candidate counts: every candidate is billed (`best_of` bills all of them, `n` returned). */
const CANDIDATE_FIELDS = [
  "n",
  "best_of",
  "candidate_count",
  "candidateCount",
  "num_return_sequences",
] as const;
/** Generation-config objects some compatible servers read the same limits from. */
const NESTED_CONFIG_FIELDS = ["generationConfig", "generation_config"] as const;

const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;

export type ProviderBodyBillingBound =
  | {
      bounded: true;
      /** The largest per-candidate output limit the body names; undefined when it names none. */
      outputTokens: bigint | undefined;
      /** How many candidates the provider may generate and bill (at least 1). */
      candidates: bigint;
    }
  | { bounded: false };

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** null: absent (or JSON null, the provider default); "invalid": present but not a count. */
function readCount(value: unknown): bigint | null | "invalid" {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return "invalid";
}

function maxOf(a: bigint | undefined, b: bigint | undefined): bigint | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a > b ? a : b;
}

export function providerBodyBillingBound(body: Uint8Array): ProviderBodyBillingBound {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return { bounded: false };
  }
  if (!isRecord(parsed)) return { bounded: false };
  const scopes: JsonRecord[] = [parsed];
  for (const field of NESTED_CONFIG_FIELDS) {
    const nested = parsed[field];
    if (nested === undefined || nested === null) continue;
    if (!isRecord(nested)) return { bounded: false };
    scopes.push(nested);
  }
  let outputTokens: bigint | undefined;
  let candidates = 1n;
  for (const scope of scopes) {
    for (const field of OUTPUT_LIMIT_FIELDS) {
      const count = readCount(scope[field]);
      if (count === "invalid") return { bounded: false };
      if (count !== null) outputTokens = maxOf(outputTokens, count);
    }
    for (const field of CANDIDATE_FIELDS) {
      const count = readCount(scope[field]);
      if (count === "invalid") return { bounded: false };
      if (count !== null && count > candidates) candidates = count;
    }
  }
  return { bounded: true, outputTokens, candidates };
}

/**
 * The per-candidate output bound an attempt reserves for: the request's (or the target's
 * default when the request names none) and anything larger the sent body names.
 */
export function attemptOutputTokens(
  bound: ProviderBodyBillingBound,
  fallback: bigint | undefined,
): bigint | undefined {
  if (!bound.bounded) return undefined;
  return maxOf(fallback, bound.outputTokens);
}

/**
 * A liability for `candidates` completions. The whole liability scales (input, output and the
 * pricing allowances), an upper bound whether or not the provider bills the prompt once.
 * Undefined when the scaled bound no longer fits (the attempt is not sent).
 */
export function scaleProviderLiability(
  liability: ProviderLiability,
  candidates: bigint,
): ProviderLiability | undefined {
  if (candidates <= 1n) return liability;
  const tokens = liability.tokens === undefined ? undefined : liability.tokens * candidates;
  if (tokens !== undefined && tokens > MAX_SIGNED_BIGINT) return undefined;
  return {
    ...liability,
    tokens,
    spend:
      liability.spend === undefined
        ? undefined
        : new Prisma.Decimal(liability.spend).mul(candidates.toString()),
  };
}
