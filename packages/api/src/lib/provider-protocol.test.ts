import { describe, expect, it } from "vitest";
import { inventoryProtocolForProviderType, providerProtocolForType } from "./provider-protocol";

describe("provider protocol mapping", () => {
  it.each([
    ["anthropic", "anthropic", "anthropic-compatible"],
    ["anthropic-compatible", "anthropic", "anthropic-compatible"],
    ["openai", "openai", "openai-compatible"],
    ["openai-compatible", "openai", "openai-compatible"],
  ] as const)("maps the recognized provider type %s", (providerType, wire, inventory) => {
    expect(providerProtocolForType(providerType)).toBe(wire);
    expect(inventoryProtocolForProviderType(providerType)).toBe(inventory);
  });

  it.each(["", "groq", "claude", "anthropic-proxy", "openaiish"])(
    "fails closed for unknown provider type %s",
    (providerType) => {
      expect(providerProtocolForType(providerType)).toBeNull();
      expect(inventoryProtocolForProviderType(providerType)).toBeNull();
    },
  );
});
