import prisma from "@ws-model-proxy/db";

/**
 * Saturation S-A: how long a request whose prefix is warm on one pool member
 * waits for that member before it spills to a cold one.
 *
 * The wait is worth it only while it is shorter than the re-prefill it saves:
 * `prefixTokens / coldPrefillTokensPerSecond`. The estimate reads counts and
 * timestamps of the member's own recent requests only, never prompt content.
 */

/** Owner decision S4: the cache-holder wait never exceeds 30 s. */
export const CACHE_HOLDER_WAIT_CAP_MS = 30_000;
/** Owner decision S4: the wait while a member's prefill speed is not measured. */
export const CACHE_HOLDER_WAIT_DEFAULT_MS = 2_000;
/** Samples below this prompt size are dominated by fixed overhead. */
export const PREFILL_SAMPLE_MIN_PROMPT_TOKENS = 2_000;
/** A sample counts as cold only when at most 5 % of its prompt hit the engine cache. */
export const PREFILL_SAMPLE_MAX_CACHE_READ_RATIO = 0.05;
export const PREFILL_SAMPLE_LIMIT = 50;
export const PREFILL_SAMPLE_WINDOW_MS = 24 * 60 * 60_000;
export const PREFILL_MIN_SAMPLES = 3;
export const PREFILL_REFRESH_INTERVAL_MS = 3 * 60_000;
const PREFILL_FAILURE_RETRY_MS = 30_000;
const PREFILL_EWMA_ALPHA = 0.3;
const MAX_CACHED_TARGETS = 10_000;

/**
 * Source of a member's cold prefill speed. The relay-history estimator below
 * is today's source; engine-reported facts (protocol 2.7, issue #70) can
 * implement the same interface later without touching routing.
 */
export interface PrefillSpeedSource {
  /** Cold prefill tokens per second, or undefined when not measured (yet). */
  tokensPerSecond(executionTargetId: string): Promise<number | undefined>;
}

export type PrefillSample = {
  promptTokens: number | null;
  cacheReadTokens: number | null;
  startedAt: Date;
  firstClientByteAt: Date | null;
  admissionWaitDurationMs: number | null;
};

/**
 * Cold prefill rate (tokens/second) of one relay row, or null when the row is
 * not a clean cold-prefill sample: a small prompt, an unreported or warm engine
 * cache, unreported admission queueing, or no measurable time to first byte.
 * TTFT excludes admission queueing: `firstClientByteAt - (startedAt +
 * admissionWaitDurationMs)`.
 */
export function coldPrefillRate(sample: PrefillSample): number | null {
  const { promptTokens, cacheReadTokens, firstClientByteAt } = sample;
  if (promptTokens === null || promptTokens < PREFILL_SAMPLE_MIN_PROMPT_TOKENS) return null;
  // Unreported cache usage may hide a warm prefix: never count it as cold.
  if (cacheReadTokens === null || cacheReadTokens < 0) return null;
  if (cacheReadTokens > promptTokens * PREFILL_SAMPLE_MAX_CACHE_READ_RATIO) return null;
  // A null queue wait cannot be separated from TTFT, so counting the row as
  // zero wait would fold admission queueing into the prefill rate.
  const admissionWaitDurationMs = sample.admissionWaitDurationMs;
  if (admissionWaitDurationMs === null || admissionWaitDurationMs < 0) return null;
  if (!firstClientByteAt) return null;
  const ttftMs =
    firstClientByteAt.getTime() - (sample.startedAt.getTime() + admissionWaitDurationMs);
  if (!Number.isFinite(ttftMs) || ttftMs <= 0) return null;
  return ((promptTokens - cacheReadTokens) * 1000) / ttftMs;
}

/** EWMA over samples ordered oldest first; undefined below the sample minimum. */
export function estimatePrefillTokensPerSecond(
  samplesOldestFirst: readonly PrefillSample[],
): number | undefined {
  const rates = samplesOldestFirst.flatMap((sample) => {
    const rate = coldPrefillRate(sample);
    return rate === null ? [] : [rate];
  });
  if (rates.length < PREFILL_MIN_SAMPLES) return undefined;
  let estimate = rates[0]!;
  for (const rate of rates.slice(1))
    estimate = PREFILL_EWMA_ALPHA * rate + (1 - PREFILL_EWMA_ALPHA) * estimate;
  return estimate > 0 && Number.isFinite(estimate) ? estimate : undefined;
}

type CachedEstimate = {
  value: number | undefined;
  expiresAt: number;
  pending?: Promise<number | undefined>;
};

/**
 * Per-process, in-memory estimator refreshed from a bounded query (the last 50
 * qualifying rows of the last 24 h, at most once per 3 minutes per target).
 * Stale or absent estimates fall back to the 2 s default in the caller.
 */
export class RelayHistoryPrefillEstimator implements PrefillSpeedSource {
  readonly #cache = new Map<string, CachedEstimate>();

  constructor(
    private readonly db: Pick<typeof prisma, "relayRequest"> = prisma,
    private readonly now: () => number = Date.now,
  ) {}

  async tokensPerSecond(executionTargetId: string): Promise<number | undefined> {
    const nowMs = this.now();
    const cached = this.#cache.get(executionTargetId);
    if (cached?.pending) return cached.pending;
    if (cached && cached.expiresAt > nowMs) return cached.value;
    const pending = this.#load(executionTargetId, nowMs).then(
      (value) => {
        this.#remember(executionTargetId, {
          value,
          expiresAt: nowMs + PREFILL_REFRESH_INTERVAL_MS,
        });
        return value;
      },
      () => {
        // Estimation is advisory: a failed read keeps the last value briefly
        // and never fails routing.
        const value = cached?.value;
        this.#remember(executionTargetId, { value, expiresAt: nowMs + PREFILL_FAILURE_RETRY_MS });
        return value;
      },
    );
    this.#remember(executionTargetId, {
      value: cached?.value,
      expiresAt: cached?.expiresAt ?? 0,
      pending,
    });
    return pending;
  }

  #remember(executionTargetId: string, entry: CachedEstimate) {
    this.#cache.delete(executionTargetId);
    if (this.#cache.size >= MAX_CACHED_TARGETS) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
    this.#cache.set(executionTargetId, entry);
  }

  async #load(executionTargetId: string, nowMs: number): Promise<number | undefined> {
    const rows = await this.db.relayRequest.findMany({
      where: {
        selectedExecutionTargetId: executionTargetId,
        status: "SUCCEEDED",
        publicEgress: false,
        // One upstream attempt: a failed pre-commit attempt's time would
        // otherwise count as prefill and understate the speed.
        attemptCount: 1,
        createdAt: { gte: new Date(nowMs - PREFILL_SAMPLE_WINDOW_MS) },
        promptTokens: { gte: PREFILL_SAMPLE_MIN_PROMPT_TOKENS },
        cacheReadTokens: { not: null },
        firstClientByteAt: { not: null },
        admissionWaitDurationMs: { not: null },
      },
      orderBy: { createdAt: "desc" },
      take: PREFILL_SAMPLE_LIMIT,
      // Counts and timestamps only: never prompt content.
      select: {
        promptTokens: true,
        cacheReadTokens: true,
        startedAt: true,
        firstClientByteAt: true,
        admissionWaitDurationMs: true,
      },
    });
    return estimatePrefillTokensPerSecond([...(rows ?? [])].reverse());
  }
}

export const prefillSpeedSource: PrefillSpeedSource = new RelayHistoryPrefillEstimator();

/**
 * Effective cache-holder wait in milliseconds.
 * - `poolOverrideMs`: null/undefined = automatic, 0 = off, N = fixed (capped at 30 s).
 * - Automatic: the re-prefill time the holder saves, `prefixTokens / tokensPerSecond`,
 *   capped at 30 s; 2 s when either the prefix size or the speed is unknown.
 */
export function cacheHolderWaitMs({
  poolOverrideMs,
  prefixTokens,
  tokensPerSecond,
}: {
  poolOverrideMs: number | null | undefined;
  prefixTokens: number | undefined;
  tokensPerSecond: number | undefined;
}): number {
  if (poolOverrideMs !== null && poolOverrideMs !== undefined)
    return Number.isFinite(poolOverrideMs)
      ? Math.min(CACHE_HOLDER_WAIT_CAP_MS, Math.max(0, Math.floor(poolOverrideMs)))
      : 0;
  if (
    prefixTokens === undefined ||
    !(prefixTokens > 0) ||
    tokensPerSecond === undefined ||
    !(tokensPerSecond > 0)
  )
    return CACHE_HOLDER_WAIT_DEFAULT_MS;
  return Math.min(CACHE_HOLDER_WAIT_CAP_MS, Math.ceil((prefixTokens * 1000) / tokensPerSecond));
}
