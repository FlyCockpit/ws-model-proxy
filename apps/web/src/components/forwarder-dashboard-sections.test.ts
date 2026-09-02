import { describe, expect, it } from "vitest";

import { shouldShowCapacitySection } from "./forwarder-dashboard-sections";

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
