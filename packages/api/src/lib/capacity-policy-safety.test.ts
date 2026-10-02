import { ORPCError } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";
import {
  assertDirectCapacityPolicy,
  assertEffectiveConcurrencyPolicy,
  assertEffectiveContextPolicy,
  assertModelPoolCapacityPolicy,
  fenceExecutionTargetIdentities,
  fenceExecutionTargetPolicies,
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

  it("reports the caller-supplied reason for each pool policy branch", () => {
    expect(
      thrownBy(() =>
        assertModelPoolCapacityPolicy(
          { concurrencyLimit: 2, reservedSlots: 3, contextCeiling: null, contextMargin: 0 },
          "POOL_POLICY_INVALID",
        ),
      ).data,
    ).toMatchObject({ reason: "POOL_POLICY_INVALID" });
    expect(
      thrownBy(() =>
        assertModelPoolCapacityPolicy(
          { concurrencyLimit: null, reservedSlots: 0, contextCeiling: 100, contextMargin: 100 },
          "POOL_POLICY_INVALID",
        ),
      ).data,
    ).toMatchObject({ reason: "POOL_POLICY_INVALID" });
  });

  it("names the failing fields even when the caller omits a reason code", () => {
    expect(
      thrownBy(() =>
        assertModelPoolCapacityPolicy({
          concurrencyLimit: 2,
          reservedSlots: 3,
          contextCeiling: null,
          contextMargin: 0,
        }),
      ).data,
    ).toEqual({ fields: ["capacityReservedSlots", "capacityConcurrencyLimit"] });
    expect(
      thrownBy(() =>
        assertModelPoolCapacityPolicy({
          concurrencyLimit: null,
          reservedSlots: 0,
          contextCeiling: 100,
          contextMargin: 100,
        }),
      ).data,
    ).toEqual({ fields: ["capacityContextMargin", "capacityContextCeiling"] });
    expect(
      thrownBy(() =>
        assertEffectiveConcurrencyPolicy({
          hardLimit: 8,
          poolLimit: 2,
          poolReserved: 3,
          memberMode: "INHERIT",
        }),
      ).data,
    ).toEqual({ fields: ["capacityReservedSlots", "capacityConcurrencyLimit"] });
    expect(
      thrownBy(() =>
        assertEffectiveConcurrencyPolicy({
          hardLimit: 2,
          poolLimit: 4,
          poolReserved: 0,
          memberMode: "INHERIT",
        }),
      ).data,
    ).toEqual({
      fields: ["capacityConcurrencyLimit", "hardConcurrencyLimit", "directConcurrencyLimit"],
    });
    expect(
      thrownBy(() =>
        assertEffectiveConcurrencyPolicy({
          hardLimit: 2,
          poolLimit: null,
          poolReserved: 3,
          memberMode: "UNLIMITED",
        }),
      ).data,
    ).toEqual({
      fields: ["capacityReservedSlots", "hardConcurrencyLimit", "directReservedSlots"],
    });
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
    ).toEqual({
      fields: [
        "capacityContextMargin",
        "capacityContextCeiling",
        "directContextMargin",
        "directContextCeiling",
      ],
    });
    expect(
      thrownBy(() =>
        assertEffectiveContextPolicy({
          physicalMaxContext: 8_192,
          poolCeiling: 8_000,
          poolMargin: 512,
          memberMode: "INHERIT",
        }),
      ).data,
    ).toEqual({
      fields: [
        "capacityContextCeiling",
        "capacityContextMargin",
        "directContextCeiling",
        "directContextMargin",
        "physicalMaxContext",
      ],
    });
  });

  it("fences unique execution-target policies in one sorted call, without row locks", async () => {
    const query = vi.fn().mockResolvedValue([{ acquired: true }]);
    const execute = vi.fn().mockResolvedValue(1);
    await fenceExecutionTargetPolicies({ $queryRaw: query, $executeRaw: execute } as never, [
      "z",
      "a",
      "z",
    ]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(String(query.mock.calls[0]?.[0]?.join("?"))).toContain("wsmp_acquire_fences");
    expect(query.mock.calls[0]?.slice(1)).toEqual([
      ["06:capacity-policy:a", "06:capacity-policy:z"],
      true,
    ]);
  });

  it("fences execution-target identities at level 02 in one sorted call", async () => {
    const query = vi.fn().mockResolvedValue([{ acquired: true }]);
    const execute = vi.fn().mockResolvedValue(1);
    await fenceExecutionTargetIdentities({ $queryRaw: query, $executeRaw: execute } as never, [
      "provider-model:b",
      "provider-model:a",
    ]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(query.mock.calls[0]?.slice(1)).toEqual([
      ["02:execution-target:provider-model:a", "02:execution-target:provider-model:b"],
      true,
    ]);
  });

  it("takes no fence for an empty target set", async () => {
    const query = vi.fn();
    await fenceExecutionTargetPolicies({ $queryRaw: query } as never, []);
    expect(query).not.toHaveBeenCalled();
  });
});
