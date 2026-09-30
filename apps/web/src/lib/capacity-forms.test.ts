import { describe, expect, it } from "vitest";

import {
  advancedDisclosureProps,
  capacityAttachmentChange,
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
      hardConcurrencyMode: "LIMITED",
      hardConcurrencyLimit: 1,
      physicalMaxContextMode: "LIMITED",
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

  it("persists explicit unlimited physical limits without coercing fallback values", () => {
    expect(
      capacityMutationPayload({
        ...newCapacityDefaults,
        hardConcurrencyMode: "UNLIMITED",
        physicalMaxContextMode: "UNLIMITED",
      }),
    ).toMatchObject({ hardConcurrencyLimit: null, physicalMaxContext: null });
  });
});

describe("capacity mutation planning", () => {
  it.each([
    { name: "untouched attached", choice: undefined, current: "auto", expected: {} },
    { name: "same AUTO", choice: "auto", current: "auto", expected: {} },
    { name: "untouched null", choice: undefined, current: null, expected: {} },
    { name: "same null", choice: "", current: null, expected: {} },
    { name: "real detach", choice: "", current: "auto", expected: { inferenceCapacityId: null } },
    {
      name: "real attach",
      choice: "other",
      current: "auto",
      expected: { inferenceCapacityId: "other" },
    },
  ])("sends only changed capacity choices: $name", ({ choice, current, expected }) => {
    expect(capacityAttachmentChange(choice, current)).toEqual(expected);
    const payload = directPolicyPayload({
      executionTargetId: "target",
      capacityId: choice,
      currentCapacityId: current,
      priority: "20",
      concurrency: "1",
      reserved: "0",
      wait: "30",
      ceiling: "2048",
      margin: "0",
      borrow: "NEVER",
    });
    expect(Object.hasOwn(payload, "inferenceCapacityId")).toBe(
      Object.hasOwn(expected, "inferenceCapacityId"),
    );
    expect(payload).toMatchObject(expected);
    const steps = createMemberFollowUps({
      memberId: "member",
      executionTargetId: "target",
      capacityId: choice,
      currentCapacityId: current,
      priority: "20",
      reserved: "0",
      wait: "30",
      ceiling: "2048",
    });
    expect(steps.map((step) => step.kind)).toEqual(
      Object.hasOwn(expected, "inferenceCapacityId")
        ? ["member-policy", "capacity-attachment"]
        : ["member-policy"],
    );
  });

  it("builds exact direct and member payloads", () => {
    expect(
      directPolicyPayload({
        executionTargetId: "target",
        capacityId: "cap",
        currentCapacityId: null,
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
      capacityConcurrencyMode: "INHERIT",
      capacityConcurrencyLimit: null,
      capacityReservedSlots: 0,
      capacityWaitBudgetMode: "INHERIT",
      capacityWaitBudgetMs: null,
      capacityContextCeilingMode: "INHERIT",
      capacityContextCeiling: null,
      capacityBorrowPolicy: null,
      capacityContextMargin: null,
    });
  });

  it("keeps member inheritance distinct from explicit unlimited limits", () => {
    const base = {
      poolMemberId: "member",
      priority: "16",
      concurrency: "2",
      reserved: "0",
      wait: "30",
      ceiling: "2048",
      margin: "128",
    };
    expect(memberPolicyPayload({ ...base, concurrencyMode: "INHERIT" })).toMatchObject({
      capacityConcurrencyMode: "INHERIT",
      capacityConcurrencyLimit: null,
    });
    expect(memberPolicyPayload({ ...base, concurrencyMode: "UNLIMITED" })).toMatchObject({
      capacityConcurrencyMode: "UNLIMITED",
      capacityConcurrencyLimit: null,
    });
    expect(memberPolicyPayload({ ...base, concurrencyMode: "LIMITED" })).toMatchObject({
      capacityConcurrencyMode: "LIMITED",
      capacityConcurrencyLimit: 2,
    });
  });

  it("orders create-member policy before target attachment and exposes recovery", () => {
    const steps = createMemberFollowUps({
      memberId: "member",
      executionTargetId: "target",
      capacityId: "cap",
      currentCapacityId: null,
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

  it("rejects concurrency above the attached hard limit", () => {
    expect(directPolicyIsValid({ ...valid, concurrency: "3" })).toBe(false);
  });

  it("accepts blank stored values only when the explicit mode is unlimited", () => {
    expect(
      directPolicyIsValid({
        ...valid,
        concurrency: "",
        concurrencyMode: "UNLIMITED",
      }),
    ).toBe(true);
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
