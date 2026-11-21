import { describe, expect, it } from "vitest";
import {
  agentTokenExpiry,
  agentTokenExpiryPresets,
  localDateInputValue,
} from "./agent-token-expiry";

const now = new Date(2026, 10, 12, 12).getTime();
const DAY_MS = 86_400_000;

describe("agent token expiry policy", () => {
  it.each([
    [1, [1]],
    [20, [7, 20]],
    [30, [7, 30]],
    [90, [7, 30, 90]],
    [180, [7, 30, 90, 180]],
    [3650, [7, 30, 90, 3650]],
  ])("offers bounded presets for a %i day maximum", (max, expected) => {
    expect(agentTokenExpiryPresets(max)).toEqual(expected);
  });

  it("allows the exact maximum and refuses a preset beyond it", () => {
    expect(agentTokenExpiry("20", "", now, 20, false)).toBe(
      new Date(now + 20 * DAY_MS).toISOString(),
    );
    expect(agentTokenExpiry("30", "", now, 20, false)).toBeUndefined();
  });

  it("requires no-expiry permission for an explicit null expiry", () => {
    expect(agentTokenExpiry("never", "", now, 90, true)).toBeNull();
    expect(agentTokenExpiry("never", "", now, 90, false)).toBeUndefined();
  });

  it("accepts custom local dates after today up to the maximum", () => {
    expect(agentTokenExpiry("custom", "2026-11-13", now, 7, false)).toBe(
      new Date(2026, 10, 13).toISOString(),
    );
    expect(agentTokenExpiry("custom", "2026-11-19", now, 7, false)).toBe(
      new Date(2026, 10, 19).toISOString(),
    );
    for (const date of ["2026-11-12", "2026-11-11", "2026-11-20", "", "bad", "2026-02-30"])
      expect(agentTokenExpiry("custom", date, now, 7, false), date).toBeUndefined();
  });

  it("formats calendar dates using local parts", () => {
    expect(localDateInputValue(new Date(2026, 0, 2, 0, 1))).toBe("2026-01-02");
  });
});
