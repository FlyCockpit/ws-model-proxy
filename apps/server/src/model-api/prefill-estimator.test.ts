import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({ default: {} }));

const {
  CACHE_HOLDER_WAIT_DEFAULT_MS,
  cacheHolderWaitMs,
  coldPrefillRate,
  estimatePrefillTokensPerSecond,
  PREFILL_REFRESH_INTERVAL_MS,
  RelayHistoryPrefillEstimator,
} = await import("./prefill-estimator.js");

const startedAt = new Date("2026-09-28T10:00:00.000Z");
/** A cold sample: `tokens` prompt tokens prefilled in `ttftMs` after admission. */
function sample(
  tokens: number,
  ttftMs: number,
  {
    cacheReadTokens = 0,
    admissionWaitDurationMs = 0,
  }: { cacheReadTokens?: number | null; admissionWaitDurationMs?: number | null } = {},
) {
  return {
    promptTokens: tokens,
    cacheReadTokens,
    startedAt,
    admissionWaitDurationMs,
    firstClientByteAt: new Date(startedAt.getTime() + (admissionWaitDurationMs ?? 0) + ttftMs),
  };
}

describe("cold prefill samples", () => {
  it("measures TTFT after admission queueing", () => {
    // 4000 tokens in 2 s after a 5 s queue: 2000 tokens/s, not 571.
    expect(coldPrefillRate(sample(4_000, 2_000, { admissionWaitDurationMs: 5_000 }))).toBe(2_000);
  });

  it("ignores warm-cache, unreported-cache, small-prompt, and non-positive TTFT samples", () => {
    expect(coldPrefillRate(sample(10_000, 1_000, { cacheReadTokens: 2_000 }))).toBeNull();
    expect(coldPrefillRate(sample(10_000, 1_000, { cacheReadTokens: null }))).toBeNull();
    expect(coldPrefillRate(sample(1_999, 1_000))).toBeNull();
    expect(coldPrefillRate({ ...sample(4_000, 1_000), firstClientByteAt: null })).toBeNull();
    expect(coldPrefillRate({ ...sample(4_000, 1_000), firstClientByteAt: startedAt })).toBeNull();
    // At most 5 % cached still counts as cold; only uncached tokens are timed.
    expect(coldPrefillRate(sample(10_000, 1_000, { cacheReadTokens: 500 }))).toBe(9_500);
  });

  it("rejects rows with unreported admission queueing", () => {
    // A null wait would silently fold queueing into TTFT.
    expect(coldPrefillRate(sample(4_000, 1_000, { admissionWaitDurationMs: null }))).toBeNull();
    expect(coldPrefillRate(sample(4_000, 1_000, { admissionWaitDurationMs: -1 }))).toBeNull();
    expect(coldPrefillRate(sample(4_000, 2_000, { admissionWaitDurationMs: 0 }))).toBe(2_000);
  });

  it("needs three clean samples and weights recent ones more", () => {
    expect(estimatePrefillTokensPerSecond([sample(4_000, 1_000), sample(4_000, 1_000)])).toBe(
      undefined,
    );
    const warmOnly = Array.from({ length: 10 }, () =>
      sample(8_000, 100, { cacheReadTokens: 7_900 }),
    );
    expect(estimatePrefillTokensPerSecond(warmOnly)).toBeUndefined();
    const estimate = estimatePrefillTokensPerSecond([
      sample(4_000, 2_000),
      sample(4_000, 2_000),
      sample(4_000, 1_000),
    ]);
    // EWMA(0.3): 2000 -> 2000 -> 0.3 * 4000 + 0.7 * 2000.
    expect(estimate).toBeCloseTo(2_600);
  });
});

describe("cache-holder wait", () => {
  it("uses the re-prefill time saved, capped at 30 s", () => {
    expect(
      cacheHolderWaitMs({ poolOverrideMs: null, prefixTokens: 6_000, tokensPerSecond: 2_000 }),
    ).toBe(3_000);
    expect(
      cacheHolderWaitMs({ poolOverrideMs: null, prefixTokens: 900_000, tokensPerSecond: 100 }),
    ).toBe(30_000);
  });

  it("falls back to 2 s when the speed or the prefix size is unknown", () => {
    expect(
      cacheHolderWaitMs({ poolOverrideMs: null, prefixTokens: 6_000, tokensPerSecond: undefined }),
    ).toBe(CACHE_HOLDER_WAIT_DEFAULT_MS);
    expect(
      cacheHolderWaitMs({
        poolOverrideMs: undefined,
        prefixTokens: undefined,
        tokensPerSecond: 50,
      }),
    ).toBe(2_000);
  });

  it("honours the pool override: 0 is off, N is fixed and capped", () => {
    const measured = { prefixTokens: 6_000, tokensPerSecond: 2_000 };
    expect(cacheHolderWaitMs({ poolOverrideMs: 0, ...measured })).toBe(0);
    expect(cacheHolderWaitMs({ poolOverrideMs: 750, ...measured })).toBe(750);
    expect(cacheHolderWaitMs({ poolOverrideMs: 99_000, ...measured })).toBe(30_000);
  });
});

describe("relay-history prefill estimator", () => {
  it("reads counts and timestamps only, caches per target, and refreshes after the interval", async () => {
    let now = startedAt.getTime();
    const findMany = vi.fn(async () => [
      // Newest first, as the query orders them.
      sample(4_000, 1_000),
      sample(4_000, 2_000),
      sample(4_000, 2_000),
    ]);
    const estimator = new RelayHistoryPrefillEstimator(
      { relayRequest: { findMany } } as never,
      () => now,
    );
    await expect(estimator.tokensPerSecond("target-a")).resolves.toBeCloseTo(2_600);
    await estimator.tokensPerSecond("target-a");
    expect(findMany).toHaveBeenCalledTimes(1);
    const query = (findMany.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]![0];
    expect(query).toMatchObject({
      where: {
        selectedExecutionTargetId: "target-a",
        status: "SUCCEEDED",
        promptTokens: { gte: 2_000 },
        cacheReadTokens: { not: null },
        admissionWaitDurationMs: { not: null },
      },
      take: 50,
    });
    expect(Object.keys(query.select as object).sort()).toEqual([
      "admissionWaitDurationMs",
      "cacheReadTokens",
      "firstClientByteAt",
      "promptTokens",
      "startedAt",
    ]);
    now += PREFILL_REFRESH_INTERVAL_MS + 1;
    await estimator.tokensPerSecond("target-a");
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("never fails routing when the history read fails", async () => {
    const estimator = new RelayHistoryPrefillEstimator({
      relayRequest: {
        findMany: vi.fn(async () => {
          throw new Error("database down");
        }),
      },
    } as never);
    await expect(estimator.tokensPerSecond("target-a")).resolves.toBeUndefined();
  });
});
