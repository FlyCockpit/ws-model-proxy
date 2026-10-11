/**
 * The billable bound of the exact body a cloud attempt sends (Codex finding 3).
 *
 * A spend reservation priced for one completion of the request's `max_tokens` is not a bound
 * when the body asks the provider for several candidates (`n`, `best_of`, ...) or names a larger
 * output limit under another field: the provider bills every candidate. The bound is read from
 * the bytes that go upstream (native forwarding and rendered bodies alike). Fields are matched by
 * family (any `max_*tokens`, any candidate count, the llama.cpp/Ollama/TGI spellings, also inside
 * a generation-config object), not by one provider's list. A matched field that is present but
 * not a non-negative safe integer (e.g. llama.cpp's `n_predict: -1`, "unlimited") cannot be
 * bounded and the attempt is not sent.
 */
import { Prisma } from "@ws-model-proxy/db";
import type { ProviderLiability } from "./provider-budget.js";

/**
 * Output-token limits (per candidate) across OpenAI, Anthropic and compatible servers: any
 * `max_*tokens` field (max_tokens, max_completion_tokens, max_output_tokens, max_new_tokens,
 * ...), plus the spellings that do not follow it (llama.cpp `n_predict`, Ollama `num_predict`,
 * Gemini-style `maxOutputTokens`, `max_length`). A field matched here that is no count is
 * refused, so an unknown alias in this family is never read as "no limit".
 */
const OUTPUT_LIMIT_FIELD =
  /^(max_\w*tokens|maxOutputTokens|maxTokens|n_predict|num_predict|max_length|max_gen_len)$/;
/**
 * Candidate counts (each candidate is billed; `best_of` bills all it generates): `n`, llama.cpp
 * `n_cmpl`, `best_of`, the `num_*` spellings of compatible servers, and any candidate-count
 * field in either case style (`candidate_count`, `candidateCount`).
 */
const CANDIDATE_FIELD =
  /^(n|n_cmpl|best_of|bestOf|num_return_sequences|num_completions|num_generations|num_samples)$|candidate_?count/i;
/** Generation-config objects compatible servers read the same limits from. */
const NESTED_CONFIG_FIELDS = [
  "generationConfig",
  "generation_config",
  "options",
  "parameters",
] as const;

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
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return { bounded: false };
  }
  // No body (stored Responses retrieve, cancel, delete, input items): nothing is generated
  // beyond what the request's own bound already covers.
  if (text.trim() === "") return { bounded: true, outputTokens: undefined, candidates: 1n };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
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
    for (const [field, value] of Object.entries(scope)) {
      const output = OUTPUT_LIMIT_FIELD.test(field);
      const candidate = CANDIDATE_FIELD.test(field);
      if (!output && !candidate) continue;
      const count = readCount(value);
      if (count === "invalid") return { bounded: false };
      if (count === null) continue;
      if (output) outputTokens = maxOf(outputTokens, count);
      if (candidate && count > candidates) candidates = count;
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
