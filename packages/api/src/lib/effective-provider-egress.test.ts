import { describe, expect, it } from "vitest";
import { poolProviderDisclosure } from "./effective-provider-egress";

describe("pool provider disclosure", () => {
  const base = {
    isOwner: false,
    hasLiveGrant: true,
    providerEgressEnabled: true,
    fallbackEnabled: true,
    fallbackForGrantees: true,
  };

  it("discloses the 0.4.0 provider types, generic included, and drops free text", () => {
    const disclosure = poolProviderDisclosure({
      ...base,
      members: [
        { tier: "PUBLIC_OVERFLOW", providerType: "generic", accountLabel: "lab" },
        { tier: "PUBLIC_OVERFLOW", providerType: " OpenRouter " },
        { tier: "PUBLIC_OVERFLOW", providerType: "my secret gateway" },
        { tier: "PRIMARY", providerType: "openai" },
      ],
    });
    expect(disclosure).toEqual({
      effectiveProviderEgress: true,
      // Account labels are the owner's.
      providerAccountLabels: [],
      providerTypes: ["generic", "openrouter"],
    });
  });

  it("discloses nothing to a grantee the fallback does not cover", () => {
    expect(
      poolProviderDisclosure({
        ...base,
        fallbackForGrantees: false,
        members: [{ tier: "PUBLIC_OVERFLOW", providerType: "generic" }],
      }),
    ).toEqual({ effectiveProviderEgress: false, providerAccountLabels: [], providerTypes: [] });
  });
});
