import { describe, expect, it } from "vitest";
import {
  inventoryProtocolForProviderType,
  PROVIDER_PRESET_BASE_URL,
  providerInventorySurfacesAllowed,
  providerProtocolForType,
} from "./provider-protocol";

describe("provider protocol mapping", () => {
  it.each([
    ["anthropic", "anthropic", "anthropic-compatible"],
    ["anthropic-compatible", "anthropic", "anthropic-compatible"],
    ["openai", "openai", "openai-compatible"],
    ["openai-compatible", "openai", "openai-compatible"],
    ["openrouter", "openai", "openai-compatible"],
    [" OpenRouter ", "openai", "openai-compatible"],
  ] as const)("maps the recognized provider type %s", (providerType, wire, inventory) => {
    expect(providerProtocolForType(providerType)).toBe(wire);
    expect(inventoryProtocolForProviderType(providerType)).toBe(inventory);
  });

  it.each(["", "groq", "claude", "anthropic-proxy", "openaiish", "open-router"])(
    "fails closed for unknown provider type %s",
    (providerType) => {
      expect(providerProtocolForType(providerType)).toBeNull();
      expect(inventoryProtocolForProviderType(providerType)).toBeNull();
      expect(providerInventorySurfacesAllowed(providerType, { version: 4, surfaces: {} })).toBe(
        false,
      );
    },
  );

  it("uses the OpenRouter API root as the preset base URL", () => {
    expect(PROVIDER_PRESET_BASE_URL.openrouter).toBe("https://openrouter.ai/api");
  });
});

describe("provider surface restrictions", () => {
  const chat = { openaiChatCompletions: { operations: ["create"] } };

  it("allows only Chat Completions on OpenRouter (Messages and Responses are not claimed)", () => {
    expect(providerInventorySurfacesAllowed("openrouter", { version: 4, surfaces: chat })).toBe(
      true,
    );
    expect(
      providerInventorySurfacesAllowed("openrouter", {
        version: 4,
        surfaces: { ...chat, openaiResponses: { operations: ["create"] } },
      }),
    ).toBe(false);
    expect(
      providerInventorySurfacesAllowed("openrouter", {
        version: 4,
        surfaces: { anthropicMessages: { operations: ["create"] } },
      }),
    ).toBe(false);
  });

  it("requires the v4 inventory for restricted types so legacy fields cannot claim surfaces", () => {
    expect(providerInventorySurfacesAllowed("openrouter", { version: 3, surfaces: chat })).toBe(
      false,
    );
    expect(providerInventorySurfacesAllowed("openrouter", { version: 1 })).toBe(false);
  });

  it("leaves unrestricted types unchanged", () => {
    expect(
      providerInventorySurfacesAllowed("openai", {
        version: 4,
        surfaces: { ...chat, openaiResponses: { operations: ["create"] } },
      }),
    ).toBe(true);
    expect(providerInventorySurfacesAllowed("openai-compatible", { version: 1 })).toBe(true);
  });
});
