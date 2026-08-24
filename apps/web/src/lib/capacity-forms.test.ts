import { describe, expect, it } from "vitest";

import {
  advancedDisclosureProps,
  capacityFormSchema,
  capacityListViewState,
  capacityMutationPayload,
  capacityUiInvariants,
  createMemberFollowUps,
  directPolicyIsValid,
  directPolicyPayload,
  followUpRecoveryState,
  memberPolicyPayload,
  newCapacityDefaults,
} from "./capacity-forms";

describe("capacity form", () => {
  it("uses conservative finite create defaults", () => {
    expect(newCapacityDefaults).toMatchObject({
      hardConcurrencyLimit: 1,
      physicalMaxContext: 32_768,
      countStrategy: "CONSERVATIVE_ESTIMATE",
    });
  });

  it("rejects blank identities and zero physical limits", () => {
    expect(capacityFormSchema.safeParse(newCapacityDefaults).success).toBe(false);
    expect(
      capacityFormSchema.safeParse({
        ...newCapacityDefaults,
        label: "Local GPU",
        runtimeModel: "model",
        runtimeIdentityKey: "runtime",
        hardConcurrencyLimit: 0,
      }).success,
    ).toBe(false);
  });

  it("normalizes optional edit fields into mutation payloads", () => {
    expect(
      capacityMutationPayload({
        ...newCapacityDefaults,
        label: " GPU ",
        runtimeModel: " model ",
        runtimeIdentityKey: " key ",
      }),
    ).toMatchObject({
      label: "GPU",
      runtimeModel: "model",
      runtimeIdentityKey: "key",
      tokenizer: null,
    });
  });
});

describe("capacity mutation planning", () => {
  it("builds exact direct and member payloads", () => {
    expect(
      directPolicyPayload({
        executionTargetId: "target",
        capacityId: "cap",
        priority: "31",
        concurrency: "2",
        reserved: "1",
        wait: "50",
        ceiling: "4096",
        margin: "128",
        borrow: "NEVER",
      }),
    ).toEqual({
      executionTargetId: "target",
      inferenceCapacityId: "cap",
      directPriority: 31,
      directConcurrencyLimit: 2,
      directReservedSlots: 1,
      directWaitBudgetMs: 50,
      directContextCeiling: 4096,
      directContextMargin: 128,
      directBorrowPolicy: "NEVER",
    });
    expect(
      memberPolicyPayload({
        poolMemberId: "member",
        priority: "4",
        reserved: "0",
        wait: "30",
        ceiling: "2048",
      }),
    ).toEqual({
      poolMemberId: "member",
      capacityPriority: 4,
      capacityReservedSlots: 0,
      capacityWaitBudgetMs: 30,
      capacityContextCeiling: 2048,
    });
  });

  it("orders create-member policy before target attachment and exposes recovery", () => {
    const steps = createMemberFollowUps({
      memberId: "member",
      executionTargetId: "target",
      capacityId: "cap",
      priority: "16",
      reserved: "1",
      wait: "30000",
      ceiling: "32768",
    });
    expect(steps.map((step) => step.kind)).toEqual(["member-policy", "capacity-attachment"]);
    expect(followUpRecoveryState(0, steps.length)).toBe("member-created");
    expect(followUpRecoveryState(1, steps.length)).toBe("policy-saved");
    expect(followUpRecoveryState(2, steps.length)).toBe("complete");
  });
});

describe("capacity view state", () => {
  it.each([
    [{ pending: true, error: false, count: 0 }, "loading"],
    [{ pending: false, error: true, count: 0 }, "error"],
    [{ pending: false, error: false, count: 0 }, "empty"],
    [{ pending: false, error: false, count: 1 }, "content"],
  ] as const)("resolves %j", (input, expected) =>
    expect(capacityListViewState(input)).toBe(expected),
  );

  it("uses native keyboard-operable disclosure elements", () => {
    expect(advancedDisclosureProps).toMatchObject({
      containerElement: "details",
      triggerElement: "summary",
    });
    expect(advancedDisclosureProps.triggerClassName).toContain("min-h-11");
  });
});

describe("admission policy validation", () => {
  const valid = {
    priority: "16",
    concurrency: "1",
    reserved: "1",
    wait: "30000",
    ceiling: "32768",
    margin: "1024",
    hardLimit: 2,
  };

  it("enforces priority bounds and nonblank positive ceilings", () => {
    expect(directPolicyIsValid(valid)).toBe(true);
    expect(directPolicyIsValid({ ...valid, priority: "32" })).toBe(false);
    expect(directPolicyIsValid({ ...valid, priority: "-1" })).toBe(false);
    expect(directPolicyIsValid({ ...valid, ceiling: "" })).toBe(false);
    expect(directPolicyIsValid({ ...valid, ceiling: "0" })).toBe(false);
  });

  it("rejects reservations above the attached hard limit", () => {
    expect(directPolicyIsValid({ ...valid, reserved: "3" })).toBe(false);
  });
});

describe("capacity UI accessibility contracts", () => {
  it("pins disclosure, touch, responsive, and overflow primitives", () => {
    expect(capacityUiInvariants).toEqual({
      touchClass: "min-h-11",
      responsiveGridClass: "sm:grid-cols-2",
      boundedHorizontalClass: "overflow-x-clip",
      advancedElement: "details",
    });
  });
});
