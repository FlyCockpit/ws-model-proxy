import { ORPCError } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({
  Prisma: {
    Decimal: class {
      value: string;
      constructor(value: string | number) {
        this.value = String(value);
      }
      toString() {
        return this.value;
      }
    },
  },
}));

const { assertPoolGrantSpendRules, poolGrantSpendCapSchema, serializePoolGrantSpendCap } =
  await import("./pool-grant-spend-cap");

describe("pool grant spend cap", () => {
  it("serializes the active SPEND rule and ignores empty policies", () => {
    expect(serializePoolGrantSpendCap(undefined)).toBeNull();
    expect(serializePoolGrantSpendCap([])).toBeNull();
    expect(
      serializePoolGrantSpendCap([
        { Rules: [{ limitValue: "25.5", currency: "USD", period: "UTC_MONTH" }] },
      ]),
    ).toEqual({ limit: "25.5", currency: "USD", period: "UTC_MONTH" });
  });

  it("rejects a zero or non-ISO currency cap", () => {
    expect(
      poolGrantSpendCapSchema.safeParse({ limit: "0", currency: "USD", period: "UTC_DAY" }).success,
    ).toBe(false);
    expect(
      poolGrantSpendCapSchema.safeParse({ limit: "1", currency: "usd", period: "UTC_DAY" }).success,
    ).toBe(false);
    expect(
      poolGrantSpendCapSchema.safeParse({ limit: "1.5", currency: "EUR", period: "UTC_DAY" })
        .success,
    ).toBe(true);
  });

  it("allows only LIMITED SPEND day/month rules", () => {
    expect(() =>
      assertPoolGrantSpendRules([
        { metric: "SPEND", period: "UTC_DAY", mode: "LIMITED", limitValue: "1", currency: "USD" },
      ]),
    ).not.toThrow();
    expect(() =>
      assertPoolGrantSpendRules([
        {
          metric: "CONCURRENCY",
          period: "PER_ATTEMPT",
          mode: "LIMITED",
          limitValue: "1",
          currency: null,
        },
      ]),
    ).toThrow(ORPCError);
  });
});
