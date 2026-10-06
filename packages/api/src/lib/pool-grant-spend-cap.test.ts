import { ORPCError } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({
  Prisma: {
    Decimal: class {
      value: string;
      constructor(value: string | number) {
        this.value = String(value);
      }
      greaterThan(other: string | number) {
        return Number(this.value) > Number(other);
      }
      toString() {
        return this.value;
      }
      toFixed() {
        return this.value;
      }
      equals(other: { value?: string } | string | number) {
        const right =
          typeof other === "object" && other && "value" in other
            ? String(other.value)
            : String(other);
        return this.value === right;
      }
    },
  },
}));

const {
  assertPoolGrantSpendRules,
  poolGrantSpendCapSchema,
  resolvePoolSpendCurrency,
  serializePoolGrantSpendCap,
} = await import("./pool-grant-spend-cap");

describe("pool grant spend cap", () => {
  it("accepts the exact Decimal(30,9) boundary without binary floating-point rounding", () => {
    expect(
      poolGrantSpendCapSchema.safeParse({
        limit: "999999999999999999999.999999999",
        currency: "USD",
        period: "UTC_DAY",
      }).success,
    ).toBe(true);
    expect(
      poolGrantSpendCapSchema.safeParse({
        limit: "0.000000001",
        currency: "USD",
        period: "UTC_DAY",
      }).success,
    ).toBe(true);
    expect(
      poolGrantSpendCapSchema.safeParse({
        limit: "0.000000000",
        currency: "USD",
        period: "UTC_DAY",
      }).success,
    ).toBe(false);
    expect(
      poolGrantSpendCapSchema.safeParse({
        limit: "1000000000000000000000",
        currency: "USD",
        period: "UTC_DAY",
      }).success,
    ).toBe(false);
  });
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
    try {
      assertPoolGrantSpendRules([
        {
          metric: "CONCURRENCY",
          period: "PER_ATTEMPT",
          mode: "LIMITED",
          limitValue: "1",
          currency: null,
        },
      ]);
    } catch (error) {
      expect(error).toBeInstanceOf(ORPCError);
      expect((error as ORPCError<string, { fields?: string[] }>).data).toEqual({
        fields: ["fallbackSpend"],
      });
    }
  });
});

describe("resolvePoolSpendCurrency", () => {
  function txWith(versionsByMember: Array<Array<{ currency: string; status: string }>>) {
    return {
      poolMember: {
        findMany: vi.fn().mockResolvedValue(
          versionsByMember.map((PricingVersions) => ({
            ExecutionTarget: { ProviderModel: { PricingVersions } },
          })),
        ),
      },
    } as unknown as Parameters<typeof resolvePoolSpendCurrency>[0];
  }

  it("takes the active version's currency over a newer retired one", async () => {
    await expect(
      resolvePoolSpendCurrency(
        txWith([
          [
            { currency: "EUR", status: "RETIRED" },
            { currency: "USD", status: "ACTIVE" },
          ],
        ]),
        { userId: "owner", poolId: "pool" },
      ),
    ).resolves.toBe("USD");
  });

  it("falls back to the newest retired version, and returns null for mixed currencies", async () => {
    await expect(
      resolvePoolSpendCurrency(txWith([[{ currency: "EUR", status: "RETIRED" }]]), {
        userId: "owner",
        poolId: "pool",
      }),
    ).resolves.toBe("EUR");
    await expect(
      resolvePoolSpendCurrency(
        txWith([[{ currency: "EUR", status: "ACTIVE" }], [{ currency: "USD", status: "ACTIVE" }]]),
        { userId: "owner", poolId: "pool" },
      ),
    ).resolves.toBeNull();
  });
});
