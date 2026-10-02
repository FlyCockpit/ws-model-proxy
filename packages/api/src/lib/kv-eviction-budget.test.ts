import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyKvEvictionContinuations,
  applyKvEvictionObservations,
  effectiveKvBudgetTokens,
  effectiveKvCut,
  KV_EVICTION_DECAY_PER_MS,
  KV_EVICTION_FLOOR_FRACTION,
  KV_EVICTION_MAX_CUT,
  KV_EVICTION_MAX_OBSERVATIONS_PER_FLUSH,
  KV_EVICTION_MISS_RATIO,
  KV_EVICTION_RECOVERY_MS,
  KV_EVICTION_SESSION_CAP,
  KV_EVICTION_STEP,
  protectionKvBudgetTokens,
} from "./kv-eviction-budget";

const now = new Date("2026-09-30T12:00:00Z");
const state = (cutFraction: number, dt = 0) => ({
  cutFraction,
  observedAt: new Date(now.getTime() - dt),
});

describe("relative eviction budget", () => {
  it("pins every feedback constant", () => {
    expect([
      KV_EVICTION_STEP,
      KV_EVICTION_MAX_CUT,
      KV_EVICTION_RECOVERY_MS,
      KV_EVICTION_MAX_OBSERVATIONS_PER_FLUSH,
      KV_EVICTION_SESSION_CAP,
      KV_EVICTION_MISS_RATIO,
      KV_EVICTION_FLOOR_FRACTION,
      KV_EVICTION_DECAY_PER_MS,
    ]).toEqual([0.05, 0.5, 1_800_000, 10, 16, 0.15, 0.5, 0.5 / 1_800_000]);
  });
  it("slot-mode engines have no token-mode K", () => {
    expect(protectionKvBudgetTokens("LLAMA_CPP", 100_000)).toBeNull();
    expect(protectionKvBudgetTokens("VLLM", 100_000)).toBe(100_000);
    expect(protectionKvBudgetTokens("VLLM", 0)).toBeNull();
  });
  it.each([
    { name: "no row", reported: 100, row: null, expected: 100 },
    ...[null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 2_147_483_648].map((reported) => ({
      name: `invalid ${reported}`,
      reported,
      row: state(0.5),
      expected: null,
    })),
    ...[1, 2, 3, 100, 2_147_483_647].map((reported) => ({
      name: `floor ${reported}`,
      reported,
      row: state(0.5),
      expected: Math.ceil(reported * 0.5),
    })),
    { name: "negative corrupt cut", reported: 100, row: state(-1), expected: 100 },
    { name: "NaN corrupt cut", reported: 100, row: state(Number.NaN), expected: 50 },
    {
      name: "infinite corrupt cut",
      reported: 100,
      row: state(Number.POSITIVE_INFINITY),
      expected: 50,
    },
    { name: "oversized corrupt cut", reported: 100, row: state(1), expected: 50 },
    { name: "future observation", reported: 100, row: state(0.5, -1000), expected: 50 },
    { name: "recovery midpoint", reported: 100, row: state(0.5, 900_000), expected: 75 },
    { name: "exact full recovery", reported: 100, row: state(0.5, 1_800_000), expected: 100 },
    { name: "beyond recovery", reported: 100, row: state(0.5, 9_000_000), expected: 100 },
    { name: "5% recovery midpoint", reported: 1000, row: state(0.05, 90_000), expected: 975 },
  ])("$name", ({ reported, row, expected }) => {
    expect(effectiveKvBudgetTokens(reported, row, now)).toBe(expected);
    const cut = effectiveKvCut(row, now);
    expect(cut).toBeGreaterThanOrEqual(0);
    expect(cut).toBeLessThanOrEqual(0.5);
  });
  it.each([
    { cut: 0, n: 1, dt: 0, expected: 0 },
    { cut: 0.05, n: 1, dt: 0, expected: 0.05 },
    { cut: 0.1, n: 1, dt: 0, expected: 0.1 },
    { cut: 0.1, n: 0, dt: 0, expected: 0.1 },
    { cut: 0, n: 11, dt: 0, expected: 0.45 },
    { cut: 0, n: 100, dt: 0, expected: 0.45 },
    { cut: 0.5, n: 10, dt: 0, expected: 0.5 },
    { cut: 0.5, n: 1, dt: 900_000, expected: 0.5 },
    { cut: 0.5, n: 1, dt: 1_800_000, expected: 0 },
    { cut: 0.1, n: 1, dt: -1000, expected: 0.1 },
  ])("decay/add $cut $n $dt", ({ cut, n, dt, expected }) => {
    const initial = state(cut, dt);
    const next = applyKvEvictionObservations(
      initial,
      Array.from({ length: n }, (_, i) => `s${i}`),
      now,
    );
    expect(next.cutFraction).toBeCloseTo(expected, 12);
    const recovered = dt >= KV_EVICTION_RECOVERY_MS && cut > 0;
    const stepped = n >= 2;
    expect(next.observedAt.getTime()).toBe(
      n === 0 || (!recovered && !stepped) ? initial.observedAt.getTime() : now.getTime(),
    );
  });
  it("a lone miss only arms; a second miss from another session cuts", () => {
    const armed = applyKvEvictionObservations(null, ["a"], now);
    expect(armed.cutFraction).toBe(0);
    expect(armed.sessionIds).toEqual(["a"]);
    expect(effectiveKvBudgetTokens(100_000, armed, now)).toBe(100_000);
    expect(applyKvEvictionObservations(armed, ["a"], now).cutFraction).toBe(0);
    const cut = applyKvEvictionObservations(armed, ["b"], now);
    expect(cut.cutFraction).toBeCloseTo(0.05, 12);
    expect(cut.sessionIds).toEqual(["a", "b"]);
    expect(effectiveKvBudgetTokens(100_000, cut, now)).toBe(95_000);
    expect(applyKvEvictionObservations(cut, ["b"], now).cutFraction).toBeCloseTo(0.05, 12);
  });
  it("two distinct sessions in one flush corroborate immediately", () => {
    expect(applyKvEvictionObservations(null, ["a", "b"], now).cutFraction).toBeCloseTo(0.05, 12);
    expect(applyKvEvictionObservations(null, ["a", "a"], now).cutFraction).toBe(0);
  });
  it("empty or oversized session ids leave state unchanged", () => {
    const armed = applyKvEvictionObservations(null, ["a"], now);
    expect(applyKvEvictionObservations(armed, ["", "x".repeat(129)], now)).toEqual(armed);
  });
  it("a recovered capacity must corroborate again", () => {
    const recovered = applyKvEvictionObservations(state(0.5, 1_800_000), ["a"], now);
    expect(recovered.cutFraction).toBe(0);
    expect(applyKvEvictionObservations(recovered, ["a"], now).cutFraction).toBe(0);
    expect(applyKvEvictionObservations(recovered, ["b"], now).cutFraction).toBeCloseTo(0.05, 12);
  });
  it("an expired pending row is a new first miss", () => {
    const expired = {
      cutFraction: 0,
      observedAt: new Date(now.getTime() - KV_EVICTION_RECOVERY_MS),
      expiresAt: now,
      sessionIds: ["a"],
    };
    const rearmed = applyKvEvictionObservations(expired, ["a"], now);
    expect(rearmed.cutFraction).toBe(0);
    expect(rearmed.observedAt.getTime()).toBe(now.getTime());
    expect(applyKvEvictionObservations(expired, ["a", "b"], now).cutFraction).toBeCloseTo(0.05, 12);
  });
  it("an expired cut does not keep stacking", () => {
    const expired = {
      cutFraction: 0.25,
      observedAt: new Date(now.getTime() - 60_000),
      expiresAt: now,
      sessionIds: ["a"],
    };
    expect(applyKvEvictionObservations(expired, ["b"], now).cutFraction).toBe(0);
  });
  it("a still-unexpired pending row corroborates from a different session", () => {
    const pending = {
      cutFraction: 0,
      observedAt: now,
      expiresAt: new Date(now.getTime() + KV_EVICTION_RECOVERY_MS),
      sessionIds: ["a"],
      missCount: 1,
      continuationCount: 1,
    };
    expect(applyKvEvictionObservations(pending, ["a"], now).cutFraction).toBe(0);
    expect(applyKvEvictionObservations(pending, ["b"], now).cutFraction).toBeCloseTo(0.05, 12);
  });
  it("repeated distinct sessions lower K to the floor, then recover exactly", () => {
    let row: ReturnType<typeof applyKvEvictionObservations> | null = null;
    for (let i = 1; i <= 100; i++) {
      row = applyKvEvictionObservations(row, [`s${i}`], now);
      expect(effectiveKvBudgetTokens(100_000, row, now)).toBeGreaterThanOrEqual(50_000);
      expect(row.cutFraction).toBeCloseTo(Math.min(0.5, Math.max(0, i - 1) * 0.05), 12);
    }
    expect(
      effectiveKvBudgetTokens(100_000, row, new Date(now.getTime() + KV_EVICTION_RECOVERY_MS)),
    ).toBe(100_000);
  });
  it("never takes occupancy or live kvUsage as eviction evidence", () => {
    const source = readFileSync(new URL("./kv-eviction-budget.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/kvOccupancy|occupancy|kvUsage/);
    // Evidence is corroborating session ids only; occupancy is display-only.
    expect(applyKvEvictionObservations(null, ["a", "b"], now).cutFraction).toBeCloseTo(0.05, 12);
  });
  it("alternating two sessions cannot walk to the floor", () => {
    let row = applyKvEvictionObservations(null, ["a"], now);
    for (let i = 0; i < 40; i++) {
      row = applyKvEvictionObservations(row, [i % 2 === 0 ? "b" : "a"], now);
    }
    expect(row.cutFraction).toBeCloseTo(0.05, 12);
    expect(row.sessionIds).toEqual(["a", "b"]);
    expect(effectiveKvBudgetTokens(100_000, row, now)).toBe(95_000);
  });
  it("steps on miss ratio, not miss count, so hits keep K up", () => {
    const hits = Array.from({ length: 10 }, (_, i) => ({
      sessionId: `h${i}`,
      kind: "hit" as const,
    }));
    const withHits = applyKvEvictionContinuations(null, hits, now);
    expect(withHits.cutFraction).toBe(0);
    const oneMiss = applyKvEvictionContinuations(
      withHits,
      [{ sessionId: "m1", kind: "miss" }],
      now,
    );
    expect(oneMiss.cutFraction).toBe(0);
    const twoMisses = applyKvEvictionContinuations(
      oneMiss,
      [{ sessionId: "m2", kind: "miss" }],
      now,
    );
    expect(twoMisses.cutFraction).toBeCloseTo(0.05, 12);
  });
});
