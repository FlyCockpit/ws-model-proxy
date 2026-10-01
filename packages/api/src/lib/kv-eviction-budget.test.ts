import { describe, expect, it } from "vitest";
import {
  applyKvEvictionObservations,
  effectiveKvBudgetTokens,
  effectiveKvCut,
  KV_EVICTION_DECAY_PER_MS,
  KV_EVICTION_FLOOR_FRACTION,
  KV_EVICTION_MAX_CUT,
  KV_EVICTION_MAX_OBSERVATIONS_PER_FLUSH,
  KV_EVICTION_RECOVERY_MS,
  KV_EVICTION_STEP,
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
      KV_EVICTION_FLOOR_FRACTION,
      KV_EVICTION_DECAY_PER_MS,
    ]).toEqual([0.05, 0.5, 1_800_000, 10, 0.5, 0.5 / 1_800_000]);
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
    { cut: 0, count: 1, dt: 0, expected: 0.05 },
    { cut: 0.05, count: 1, dt: 0, expected: 0.1 },
    { cut: 0.1, count: 1, dt: 0, expected: 0.15 },
    { cut: 0.1, count: 0, dt: 0, expected: 0.1 },
    { cut: 0.1, count: -5, dt: 0, expected: 0.1 },
    { cut: 0, count: 11, dt: 0, expected: 0.5 },
    { cut: 0, count: 100, dt: 0, expected: 0.5 },
    { cut: 0.5, count: 10, dt: 0, expected: 0.5 },
    { cut: 0.5, count: 1, dt: 900_000, expected: 0.3 },
    { cut: 0.5, count: 1, dt: 1_800_000, expected: 0 },
    { cut: 0.1, count: 1, dt: -1000, expected: 0.15 },
  ])("decay/add $cut $count $dt", ({ cut, count, dt, expected }) => {
    const initial = state(cut, dt);
    const next = applyKvEvictionObservations(initial, count, now);
    expect(next.cutFraction).toBeCloseTo(expected, 12);
    expect(next.observedAt.getTime()).toBe(Math.max(initial.observedAt.getTime(), now.getTime()));
  });
  it("a lone miss only arms; a second miss cuts", () => {
    const armed = applyKvEvictionObservations(null, 1, now);
    expect(armed.cutFraction).toBe(0);
    expect(effectiveKvBudgetTokens(100_000, armed, now)).toBe(100_000);
    const cut = applyKvEvictionObservations(armed, 1, now);
    expect(cut.cutFraction).toBeCloseTo(0.05, 12);
    expect(effectiveKvBudgetTokens(100_000, cut, now)).toBe(95_000);
  });
  it("two misses in one flush corroborate immediately", () => {
    expect(applyKvEvictionObservations(null, 2, now).cutFraction).toBeCloseTo(0.05, 12);
  });
  it("a recovered capacity must corroborate again", () => {
    const recovered = applyKvEvictionObservations(state(0.5, 1_800_000), 1, now);
    expect(recovered.cutFraction).toBe(0);
    expect(applyKvEvictionObservations(recovered, 1, now).cutFraction).toBeCloseTo(0.05, 12);
  });
  it("repeated events lower K to the floor, then recover exactly", () => {
    let row: ReturnType<typeof applyKvEvictionObservations> | null = null;
    for (let i = 1; i <= 100; i++) {
      row = applyKvEvictionObservations(row, 1, now);
      expect(effectiveKvBudgetTokens(100_000, row, now)).toBeGreaterThanOrEqual(50_000);
      expect(row.cutFraction).toBeCloseTo(Math.min(0.5, Math.max(0, i - 1) * 0.05), 12);
    }
    expect(
      effectiveKvBudgetTokens(100_000, row, new Date(now.getTime() + KV_EVICTION_RECOVERY_MS)),
    ).toBe(100_000);
  });
});
