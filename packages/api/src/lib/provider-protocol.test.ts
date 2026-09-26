import { describe, expect, it } from "vitest";
import {
  inventoryProtocolForProviderType,
  PROVIDER_PRESET_BASE_URL,
  providerCredentialProbeUrl,
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

describe("credential probe URL", () => {
  it.each([
    ["openrouter", "https://openrouter.ai/api", "https://openrouter.ai/api/v1/key"],
    ["OpenRouter", "https://openrouter.ai/api/", "https://openrouter.ai/api/v1/key"],
    [
      "openrouter",
      "https://gateway.example/openrouter",
      "https://gateway.example/openrouter/v1/key",
    ],
  ])("probes the authenticated key endpoint for %s at %s", (providerType, baseUrl, expected) => {
    expect(providerCredentialProbeUrl(providerType, baseUrl)).toBe(expected);
  });

  it("stays on the account's own origin", () => {
    const probe = new URL(providerCredentialProbeUrl("openrouter", "https://openrouter.ai/api"));
    expect(probe.origin).toBe("https://openrouter.ai");
  });

  it.each(["openai", "openai-compatible", "anthropic", "anthropic-compatible", "unknown"])(
    "keeps the base URL for %s (known follow-up)",
    (providerType) => {
      expect(providerCredentialProbeUrl(providerType, "https://provider.example/v1")).toBe(
        "https://provider.example/v1",
      );
    },
  );

  it("leaves an invalid base URL for the egress layer to reject", () => {
    expect(providerCredentialProbeUrl("openrouter", "not a url")).toBe("not a url");
  });
});
