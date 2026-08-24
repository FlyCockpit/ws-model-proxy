import { describe, expect, it } from "vitest";

import {
  capacityFormSchema,
  capacityMutationPayload,
  capacityUiInvariants,
  directPolicyIsValid,
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
