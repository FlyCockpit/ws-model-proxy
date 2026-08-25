import { describe, expect, it, vi } from "vitest";
import {
  assertDirectCapacityPolicy,
  assertEffectiveConcurrencyPolicy,
  assertEffectiveContextPolicy,
  lockExecutionTargetPolicies,
} from "./capacity-policy-safety";

describe("capacity policy safety", () => {
  it("enforces direct relational invariants without physical caps", () => {
    expect(() =>
      assertDirectCapacityPolicy({
        hardLimit: null,
        concurrencyLimit: 2,
        reservedSlots: 3,
        physicalMaxContext: null,
        contextCeiling: null,
        contextMargin: 0,
      }),
    ).toThrow(/direct concurrency/i);
    expect(() =>
      assertDirectCapacityPolicy({
        hardLimit: null,
        concurrencyLimit: null,
        reservedSlots: 3,
        physicalMaxContext: null,
        contextCeiling: 100,
        contextMargin: 100,
      }),
    ).toThrow(/context margin/i);
  });

  it.each([
    ["INHERIT", null, null, 4, 3, 2],
    ["LIMITED", 2, 2, 8, 1, 1],
    ["UNLIMITED", null, 3, 4, 3, 3],
  ] as const)(
    "accepts valid %s concurrency policy",
    (mode, limit, reserved, hard, pool, poolReserved) => {
      expect(() =>
        assertEffectiveConcurrencyPolicy({
          hardLimit: hard,
          poolLimit: pool,
          poolReserved,
          memberMode: mode,
          memberLimit: limit,
          memberReserved: reserved,
        }),
      ).not.toThrow();
    },
  );

  it("rejects reserved slots above inherited and overridden finite limits", () => {
    expect(() =>
      assertEffectiveConcurrencyPolicy({
        hardLimit: 8,
        poolLimit: 2,
        poolReserved: 3,
        memberMode: "INHERIT",
      }),
    ).toThrow(/effective concurrency/i);
    expect(() =>
      assertEffectiveConcurrencyPolicy({
        hardLimit: 8,
        poolLimit: 8,
        poolReserved: 0,
        memberMode: "LIMITED",
        memberLimit: 2,
        memberReserved: 3,
      }),
    ).toThrow(/effective concurrency/i);
  });

  it("still enforces the hard cap for unlimited policy", () => {
    expect(() =>
      assertEffectiveConcurrencyPolicy({
        hardLimit: 2,
        poolLimit: null,
        poolReserved: 3,
        memberMode: "UNLIMITED",
      }),
    ).toThrow(/physical concurrency/i);
  });

  it.each([
    ["INHERIT", null, null, 10_000, 8_000, 1_000],
    ["LIMITED", 7_000, 500, 10_000, 9_000, 100],
    ["UNLIMITED", null, null, 1_000, 9_000, 500],
  ] as const)(
    "resolves valid %s context policy",
    (mode, ceiling, margin, physical, pool, poolMargin) => {
      expect(() =>
        assertEffectiveContextPolicy({
          physicalMaxContext: physical,
          poolCeiling: pool,
          poolMargin,
          memberMode: mode,
          memberCeiling: ceiling,
          memberMargin: margin,
        }),
      ).not.toThrow();
    },
  );

  it("rejects inherited and limited context policies beyond physical context", () => {
    expect(() =>
      assertEffectiveContextPolicy({
        physicalMaxContext: 8_192,
        poolCeiling: 8_000,
        poolMargin: 512,
        memberMode: "INHERIT",
      }),
    ).toThrow(/physical capacity/i);
    expect(() =>
      assertEffectiveContextPolicy({
        physicalMaxContext: 8_192,
        poolCeiling: null,
        poolMargin: 0,
        memberMode: "LIMITED",
        memberCeiling: 8_000,
        memberMargin: 512,
      }),
    ).toThrow(/physical capacity/i);
  });

  it("locks unique execution targets in stable lexical order", async () => {
    const query = vi.fn().mockResolvedValue([]);
    await lockExecutionTargetPolicies({ $queryRaw: query } as never, ["z", "a", "z"]);
    expect(query).toHaveBeenCalledTimes(4);
    expect(String(query.mock.calls[1]?.[0]?.[0])).toContain("pg_advisory_xact_lock");
    expect(query.mock.calls[0]?.slice(1)).toEqual(["a"]);
    expect(query.mock.calls[1]?.slice(1)).toEqual(["capacity-policy:a"]);
    expect(query.mock.calls[2]?.slice(1)).toEqual(["z"]);
    expect(query.mock.calls[3]?.slice(1)).toEqual(["capacity-policy:z"]);
  });
});
