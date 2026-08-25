import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({ default: {} }));

import { classifyProviderFailure, parseRetryAfter } from "./provider-attempt-runtime.js";

describe("provider attempt failure policy", () => {
  it.each([
    [408, "TIMEOUT"],
    [409, "CONFLICT"],
    [429, "RATE_LIMIT"],
    [500, "SERVER"],
    [599, "SERVER"],
    [400, "PROTOCOL"],
    [undefined, "TRANSPORT"],
  ] as const)("classifies status %s", (status, expected) => {
    expect(classifyProviderFailure(status)).toBe(expected);
  });

  it("parses delta seconds and clamps retry-after dates", () => {
    expect(parseRetryAfter("12", 0)).toBe(12_000);
    expect(parseRetryAfter("Wed, 01 Jan 2025 00:01:00 GMT", Date.UTC(2025, 0, 1))).toBe(60_000);
    expect(parseRetryAfter("999999", 0)).toBe(300_000);
    expect(parseRetryAfter("invalid", 0)).toBeUndefined();
  });
});
