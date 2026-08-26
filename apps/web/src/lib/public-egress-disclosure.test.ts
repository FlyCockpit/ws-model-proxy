import { describe, expect, it } from "vitest";

import { publicEgressResourceNames } from "./public-egress-disclosure";

describe("publicEgressResourceNames", () => {
  it("names only resources whose effective configuration permits public egress", () => {
    expect(
      publicEgressResourceNames([
        { name: "Local only", publicEgressEnabled: false },
        {
          name: "Provider primary",
          publicEgressEnabled: false,
          effectiveProviderEgress: true,
        },
        { name: "Guarded overflow", publicEgressEnabled: true },
      ]),
    ).toEqual(["Provider primary", "Guarded overflow"]);
  });
});
