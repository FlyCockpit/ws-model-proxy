import { describe, expect, it } from "vitest";
import {
  guardedPoolCreateFailureReasons,
  isGuardedPoolCreateFailureReason,
} from "./guarded-pool-create-reasons";

describe("isGuardedPoolCreateFailureReason", () => {
  it("accepts every code in the frozen reason contract", () => {
    for (const reason of guardedPoolCreateFailureReasons)
      expect(isGuardedPoolCreateFailureReason(reason)).toBe(true);
  });

  it("rejects strings outside the contract", () => {
    expect(isGuardedPoolCreateFailureReason("NOT_A_REAL_REASON")).toBe(false);
    expect(isGuardedPoolCreateFailureReason("")).toBe(false);
    expect(isGuardedPoolCreateFailureReason("slug_invalid")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isGuardedPoolCreateFailureReason(undefined)).toBe(false);
    expect(isGuardedPoolCreateFailureReason(null)).toBe(false);
    expect(isGuardedPoolCreateFailureReason(42)).toBe(false);
    expect(isGuardedPoolCreateFailureReason({ reason: "SLUG_TAKEN" })).toBe(false);
    expect(isGuardedPoolCreateFailureReason(["SLUG_TAKEN"])).toBe(false);
  });
});
