import { ORPCError } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";
import {
  assertDirectCapacityPolicy,
  assertEffectiveConcurrencyPolicy,
  assertEffectiveContextPolicy,
  lockExecutionTargetPolicies,
} from "./capacity-policy-safety";

function thrownBy(action: () => void): ORPCError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ORPCError);
    return error as ORPCError;
  }
  throw new Error("expected an ORPCError to be thrown");
}

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

  it("reports a distinct caller-supplied reason per concurrency branch", () => {
    const reasons = {
      reservedExceeds: "RESERVED_EXCEEDS_CONCURRENCY",
      reservedExceedsPhysical: "RESERVED_EXCEEDS_PHYSICAL",
      concurrencyExceedsPhysical: "CONCURRENCY_EXCEEDS_PHYSICAL",
    } as const;

    const reservedAboveLimit = thrownBy(() =>
      assertEffectiveConcurrencyPolicy(
        {
          hardLimit: 8,
          poolLimit: 2,
          poolReserved: 3,
          memberMode: "INHERIT",
        },
        reasons,
      ),
    );
    expect(reservedAboveLimit.data).toMatchObject({
      reason: "RESERVED_EXCEEDS_CONCURRENCY",
    });

    const limitAbovePhysical = thrownBy(() =>
      assertEffectiveConcurrencyPolicy(
        {
          hardLimit: 2,
          poolLimit: 4,
          poolReserved: 0,
          memberMode: "INHERIT",
        },
        reasons,
      ),
    );
    expect(limitAbovePhysical.data).toMatchObject({
      reason: "CONCURRENCY_EXCEEDS_PHYSICAL",
    });

    const reservedAbovePhysical = thrownBy(() =>
      assertEffectiveConcurrencyPolicy(
        {
          hardLimit: 2,
          poolLimit: null,
          poolReserved: 3,
          memberMode: "UNLIMITED",
        },
        reasons,
      ),
    );
    expect(reservedAbovePhysical.data).toMatchObject({
      reason: "RESERVED_EXCEEDS_PHYSICAL",
    });
  });

  it("reports a distinct caller-supplied reason per context branch", () => {
    const reasons = {
      marginExceedsCeiling: "CONTEXT_MARGIN_EXCEEDS_CEILING",
      exceedsPhysical: "CONTEXT_EXCEEDS_PHYSICAL",
    } as const;

    const marginAboveCeiling = thrownBy(() =>
      assertEffectiveContextPolicy(
        {
          physicalMaxContext: 10_000,
          poolCeiling: null,
          poolMargin: 0,
          memberMode: "LIMITED",
          memberCeiling: 100,
          memberMargin: 100,
        },
        reasons,
      ),
    );
    expect(marginAboveCeiling.data).toMatchObject({
      reason: "CONTEXT_MARGIN_EXCEEDS_CEILING",
    });

    const policyAbovePhysical = thrownBy(() =>
      assertEffectiveContextPolicy(
        {
          physicalMaxContext: 8_192,
          poolCeiling: 8_000,
          poolMargin: 512,
          memberMode: "INHERIT",
        },
        reasons,
      ),
    );
    expect(policyAbovePhysical.data).toMatchObject({
      reason: "CONTEXT_EXCEEDS_PHYSICAL",
    });
  });

  it("keeps the prior error envelope for callers that omit reasons", () => {
    // Every other caller of these shared helpers passes no reasons; their
    // thrown ORPCError must carry no `data` field, byte-for-byte as before.
    expect(
      thrownBy(() =>
        assertEffectiveConcurrencyPolicy({
          hardLimit: 8,
          poolLimit: 2,
          poolReserved: 3,
          memberMode: "INHERIT",
        }),
      ).data,
    ).toBeUndefined();
    expect(
      thrownBy(() =>
        assertEffectiveConcurrencyPolicy({
          hardLimit: 2,
          poolLimit: 4,
          poolReserved: 0,
          memberMode: "INHERIT",
        }),
      ).data,
    ).toBeUndefined();
    expect(
      thrownBy(() =>
        assertEffectiveConcurrencyPolicy({
          hardLimit: 2,
          poolLimit: null,
          poolReserved: 3,
          memberMode: "UNLIMITED",
        }),
      ).data,
    ).toBeUndefined();
    expect(
      thrownBy(() =>
        assertEffectiveContextPolicy({
          physicalMaxContext: 10_000,
          poolCeiling: null,
          poolMargin: 0,
          memberMode: "LIMITED",
          memberCeiling: 100,
          memberMargin: 100,
        }),
      ).data,
    ).toBeUndefined();
    expect(
      thrownBy(() =>
        assertEffectiveContextPolicy({
          physicalMaxContext: 8_192,
          poolCeiling: 8_000,
          poolMargin: 512,
          memberMode: "INHERIT",
        }),
      ).data,
    ).toBeUndefined();
  });

  it("locks unique execution targets in stable lexical order", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const execute = vi.fn().mockResolvedValue(1);
    await lockExecutionTargetPolicies({ $queryRaw: query, $executeRaw: execute } as never, [
      "z",
      "a",
      "z",
    ]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(String(execute.mock.calls[0]?.[0]?.[0])).toContain("pg_advisory_xact_lock");
    expect(query.mock.calls[0]?.slice(1)).toEqual(["a"]);
    expect(execute.mock.calls[0]?.slice(1)).toEqual(["capacity-policy:a"]);
    expect(query.mock.calls[1]?.slice(1)).toEqual(["z"]);
    expect(execute.mock.calls[1]?.slice(1)).toEqual(["capacity-policy:z"]);
  });
});
