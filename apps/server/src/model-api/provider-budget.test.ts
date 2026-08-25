import { describe, expect, it } from "vitest";
import { budgetWindow, providerBillableTokens } from "./provider-budget-accounting.js";

describe("provider budget accounting", () => {
  it("uses half-open UTC day windows across a year boundary", () => {
    const result = budgetWindow(
      "UTC_DAY",
      new Date("2025-01-01T00:00:00.000Z"),
      new Date("2025-12-31T23:59:59.999Z"),
    );
    expect(result).toEqual({
      windowStart: new Date("2025-12-31T00:00:00.000Z"),
      windowEnd: new Date("2026-01-01T00:00:00.000Z"),
    });
  });

  it("uses UTC calendar-month boundaries including leap years", () => {
    expect(
      budgetWindow(
        "UTC_MONTH",
        new Date("2024-01-01T00:00:00.000Z"),
        new Date("2024-02-29T23:59:59.999-05:00"),
      ),
    ).toEqual({
      windowStart: new Date("2024-03-01T00:00:00.000Z"),
      windowEnd: new Date("2024-04-01T00:00:00.000Z"),
    });
  });

  it("binds lifetime to immutable activation and per-attempt to attempt identity", () => {
    const activatedAt = new Date("2025-03-04T05:06:07.000Z");
    expect(budgetWindow("LIFETIME", activatedAt, new Date())).toEqual({
      windowStart: activatedAt,
      windowEnd: null,
    });
    expect(budgetWindow("PER_ATTEMPT", activatedAt, new Date())).toEqual({
      windowStart: null,
      windowEnd: null,
    });
  });

  it("sums provider-billable categories without substituting an aggregate total", () => {
    expect(
      providerBillableTokens({
        inputTokens: 100n,
        outputTokens: 20n,
        cacheReadTokens: 10n,
        cacheWriteTokens: 5n,
        reasoningTokens: 7n,
        toolTokens: 3n,
        additionalBillableTokens: 2n,
      }),
    ).toBe(147n);
  });

  it("keeps wholly missing usage unknown rather than treating it as zero", () => {
    expect(providerBillableTokens({})).toBeUndefined();
  });
});
