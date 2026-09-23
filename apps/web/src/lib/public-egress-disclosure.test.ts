import { describe, expect, it } from "vitest";

import { egressProviderAccountLabels, publicEgressResourceNames } from "./public-egress-disclosure";

describe("publicEgressResourceNames", () => {
  it("names only resources the server marks as using an external provider", () => {
    expect(
      publicEgressResourceNames([
        { name: "Local only", effectiveProviderEgress: false },
        { name: "Provider primary", effectiveProviderEgress: true },
        { name: "Missing flag" },
      ]),
    ).toEqual(["Provider primary"]);
  });

  it("collects provider account labels already present on the payload", () => {
    expect(
      egressProviderAccountLabels([
        { providerAccountLabels: ["Ada's OpenAI", "Ada's OpenAI"] },
        { providerAccountLabels: ["Backup"] },
        {},
      ]),
    ).toEqual(["Ada's OpenAI", "Backup"]);
  });
});
