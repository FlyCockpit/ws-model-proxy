import { describe, expect, it } from "vitest";

import {
  resolveCapacityAvailability,
  shouldShowCapacitySection,
  shouldShowProviderOperationsSection,
} from "./forwarder-dashboard-sections";

describe("resolveCapacityAvailability", () => {
  it.each([
    [true, true, "enabled"],
    [false, true, "disabled"],
    [undefined, true, "error"],
    [undefined, false, "loading"],
  ] as const)(
    "prefers resolved capacity value %s when config error is %s",
    (value, isError, expected) => {
      expect(resolveCapacityAvailability(value, isError)).toBe(expected);
    },
  );
});

describe("shouldShowCapacitySection", () => {
  it("hides disabled capacity UI when a skipped query is pending without data", () => {
    expect(shouldShowCapacitySection(false, false, undefined)).toBe(false);
    expect(shouldShowCapacitySection(false, false, [])).toBe(false);
  });

  it("shows enabled capacity UI while fetching and after data resolves", () => {
    expect(shouldShowCapacitySection(true, true, undefined)).toBe(true);
    expect(shouldShowCapacitySection(true, false, [])).toBe(true);
  });
});

describe("shouldShowProviderOperationsSection", () => {
  it("does not mount provider management until the server capability is enabled", () => {
    expect(shouldShowProviderOperationsSection(undefined)).toBe(false);
    expect(shouldShowProviderOperationsSection(false)).toBe(false);
  });

  it("mounts provider management when the server capability is enabled", () => {
    expect(shouldShowProviderOperationsSection(true)).toBe(true);
  });
});
