import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({ default: {} }));

const { cacheHolderMemberIds, cacheHolderOutcome, planCacheHolderWait, spillDelayMs } =
  await import("./cache-holder-wait.js");
const { CACHE_HOLDER_WAIT_DEFAULT_MS } = await import("./prefill-estimator.js");

type Decision = Parameters<typeof cacheHolderMemberIds>[0];

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    orderedTargetIds: ["t-a", "t-b", "t-c"],
    scores: {},
    prefixDepths: {},
    conversationMatches: {},
    reasons: {},
    matchedPrefixDepth: 0,
    ...overrides,
  };
}

const candidates = [
  { poolMemberId: "a", executionTargetId: "t-a" },
  { poolMemberId: "b", executionTargetId: "t-b" },
  { poolMemberId: "c", executionTargetId: "t-c" },
];

describe("cache holder members", () => {
  it("takes every member tied at the deepest prefix match", () => {
    const holders = cacheHolderMemberIds(
      decision({ prefixDepths: { "t-a": 3, "t-b": 3, "t-c": 1 } }),
      candidates,
    );
    expect([...holders].sort()).toEqual(["a", "b"]);
  });

  it("falls back to conversation matches only when no prefix matched", () => {
    expect([
      ...cacheHolderMemberIds(
        decision({ conversationMatches: { "t-b": true, "t-c": false } }),
        candidates,
      ),
    ]).toEqual(["b"]);
    // A prefix hit wins over a conversation match elsewhere.
    expect([
      ...cacheHolderMemberIds(
        decision({ prefixDepths: { "t-c": 1 }, conversationMatches: { "t-b": true } }),
        candidates,
      ),
    ]).toEqual(["c"]);
  });

  it("has no holder without a real hit or a target identity", () => {
    expect(cacheHolderMemberIds(decision(), candidates).size).toBe(0);
    expect(
      cacheHolderMemberIds(decision({ conversationMatches: { "t-a": true } }), [
        { poolMemberId: "a", executionTargetId: undefined },
      ]).size,
    ).toBe(0);
  });
});

describe("spill delay per round", () => {
  const plan = { holderMemberIds: new Set(["a"]), windowMs: 2_000 };

  it("defers only non-holders, and only in rounds that include a holder", () => {
    expect(spillDelayMs(plan, "a", true, 0)).toBeUndefined();
    expect(spillDelayMs(plan, "b", true, 0)).toBe(2_000);
    // The holder already failed (not in this round): nobody is held back.
    expect(spillDelayMs(plan, "b", false, 0)).toBeUndefined();
    expect(spillDelayMs(null, "b", true, 0)).toBeUndefined();
  });

  it("reuses the original window on later rounds instead of restarting it", () => {
    expect(spillDelayMs(plan, "b", true, 1_000)).toBe(1_000);
    expect(spillDelayMs(plan, "b", true, 1_999.4)).toBe(1);
    expect(spillDelayMs(plan, "b", true, 2_000)).toBeUndefined();
    expect(spillDelayMs(plan, "b", true, 5_000)).toBeUndefined();
    // A negative elapsed time (clock jitter) never lengthens the window.
    expect(spillDelayMs(plan, "b", true, -50)).toBe(2_000);
  });
});

describe("cache holder plan", () => {
  const speedSource = (tokensPerSecond: () => Promise<number | undefined>) => ({
    tokensPerSecond: vi.fn(tokensPerSecond),
  });

  it("uses the 2 s default when the speed source fails", async () => {
    const source = speedSource(async () => {
      throw new Error("history unavailable");
    });
    const plan = await planCacheHolderWait({
      decision: decision({ prefixDepths: { "t-a": 2 }, prefixTokens: { "t-a": 8_000 } }),
      candidates,
      poolOverrideMs: null,
      speedSource: source,
    });
    expect(source.tokensPerSecond).toHaveBeenCalledWith("t-a");
    expect(plan).toEqual({
      holderMemberIds: new Set(["a"]),
      windowMs: CACHE_HOLDER_WAIT_DEFAULT_MS,
    });
  });

  it("returns no plan when the wait is off, every candidate holds the prefix, or there is one candidate", async () => {
    const source = speedSource(async () => 1_000);
    const hit = decision({ prefixDepths: { "t-a": 2 } });
    await expect(
      planCacheHolderWait({ decision: hit, candidates, poolOverrideMs: 0, speedSource: source }),
    ).resolves.toBeNull();
    await expect(
      planCacheHolderWait({
        decision: decision({ prefixDepths: { "t-a": 2, "t-b": 2, "t-c": 2 } }),
        candidates,
        poolOverrideMs: null,
        speedSource: source,
      }),
    ).resolves.toBeNull();
    await expect(
      planCacheHolderWait({
        decision: hit,
        candidates: candidates.slice(0, 1),
        poolOverrideMs: null,
        speedSource: source,
      }),
    ).resolves.toBeNull();
  });
});

describe("cache holder outcome", () => {
  const plan = { holderMemberIds: new Set(["a"]), windowMs: 2_000 };

  it("names who the held admission granted", () => {
    expect(cacheHolderOutcome(plan, "a")).toBe("HOLDER_WAITED");
    expect(cacheHolderOutcome(plan, "b")).toBe("HOLDER_SPILLED");
    expect(cacheHolderOutcome(null, "a")).toBeNull();
  });
});
