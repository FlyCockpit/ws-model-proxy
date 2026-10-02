import { describe, expect, it, vi } from "vitest";
import { budgetWindow, providerBillableTokens } from "./provider-budget-accounting.js";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret",
    BETTER_AUTH_URL: "https://proxy.example.com",
    WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: true,
    NODE_ENV: "test",
  },
}));

vi.mock("@ws-model-proxy/env/shared", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret",
    DATABASE_URL: "postgresql://provider-budget-test",
    NODE_ENV: "test",
  },
}));

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { grantCapDenial, reservationIdentityWhere, reservationWindowWhere } = await import(
  "./provider-budget.js"
);

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
        categoriesComplete: true,
      }),
    ).toBe(147n);
  });

  it("keeps wholly missing usage unknown rather than treating it as zero", () => {
    expect(providerBillableTokens({})).toBeUndefined();
  });

  it("keeps partial categories unknown and trusts an authoritative total without double counting", () => {
    expect(providerBillableTokens({ inputTokens: 10n })).toBeUndefined();
    expect(providerBillableTokens({ inputTokens: 10n, authoritativeBillableTokens: 12n })).toBe(
      12n,
    );
  });

  it("does not trust even an authoritative aggregate from an incomplete stream", () => {
    expect(
      providerBillableTokens({
        authoritativeBillableTokens: 12n,
        categoriesComplete: false,
      }),
    ).toBeUndefined();
  });
});

describe("grantCapDenial", () => {
  const policy = { id: "policy", scopeType: "POOL_GRANT" };

  it("maps an exhausted cap to GRANTEE_BUDGET_EXCEEDED", () => {
    expect(grantCapDenial(policy, "rule", "BUDGET_EXCEEDED")).toEqual({
      admitted: false,
      reason: "GRANTEE_BUDGET_EXCEEDED",
      policyId: "policy",
      ruleId: "rule",
    });
  });

  it("keeps pricing and currency failures distinct from an exhausted cap", () => {
    expect(grantCapDenial(policy, "rule", "PRICING_UNAVAILABLE").reason).toBe(
      "GRANTEE_CAP_UNPRICEABLE",
    );
    expect(grantCapDenial(policy, "rule", "CURRENCY_UNAVAILABLE").reason).toBe(
      "GRANTEE_CAP_UNPRICEABLE",
    );
  });

  it("leaves other scopes unmapped", () => {
    expect(
      grantCapDenial({ id: "policy", scopeType: "PROVIDER_ACCOUNT" }, "rule", "PRICING_UNAVAILABLE")
        .reason,
    ).toBe("PRICING_UNAVAILABLE");
  });
});

describe("grant-cap reservation identity and window", () => {
  const grantPolicy = { id: "policy-current", scopeType: "POOL_GRANT" as const };
  const spendRule = {
    id: "rule-usd-month",
    metric: "SPEND" as const,
    period: "UTC_MONTH" as const,
    currency: "USD",
  };
  const window = {
    windowStart: new Date("2026-04-01T00:00:00.000Z"),
    windowEnd: new Date("2026-05-01T00:00:00.000Z"),
  };

  it("omits period so same-currency spend still matches after a period change", () => {
    expect(
      reservationIdentityWhere(grantPolicy, spendRule, ["policy-old", "policy-current"]),
    ).toEqual({
      policyId: { in: ["policy-old", "policy-current"] },
      metric: "SPEND",
      currency: "USD",
    });
  });

  it("starts a new identity when the cap currency changes", () => {
    expect(
      reservationIdentityWhere(grantPolicy, { ...spendRule, currency: "EUR" }, ["policy-current"]),
    ).toEqual({
      policyId: { in: ["policy-current"] },
      metric: "SPEND",
      currency: "EUR",
    });
  });

  it("sums POOL_GRANT reservations by createdAt in the current wall-clock window", () => {
    expect(reservationWindowWhere(grantPolicy, spendRule, window, "attempt-1")).toEqual({
      createdAt: { gte: window.windowStart, lt: window.windowEnd },
    });
    expect(
      reservationWindowWhere(
        grantPolicy,
        { metric: "SPEND", period: "LIFETIME" },
        { windowStart: window.windowStart, windowEnd: null },
        "attempt-1",
      ),
    ).toEqual({ createdAt: { gte: window.windowStart } });
  });

  it("keeps non-grant reservations pinned to the stored window bounds", () => {
    expect(
      reservationWindowWhere({ scopeType: "PROVIDER_ACCOUNT" }, spendRule, window, "attempt-1"),
    ).toEqual({ windowStart: window.windowStart, windowEnd: window.windowEnd });
    expect(
      reservationWindowWhere(
        grantPolicy,
        { metric: "CONCURRENCY", period: "UTC_MONTH" },
        window,
        "attempt-1",
      ),
    ).toEqual({});
    expect(
      reservationWindowWhere(
        grantPolicy,
        { metric: "SPEND", period: "PER_ATTEMPT" },
        window,
        "attempt-1",
      ),
    ).toEqual({ attemptId: "attempt-1" });
  });
});
