import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_DEFAULT_API_VERSION,
  classifyCredentialProbeStatus,
  inventoryProtocolForProviderType,
  PROVIDER_PRESET_BASE_URL,
  providerCredentialProbe,
  providerInventorySurfacesAllowed,
  providerProtocolForType,
  providerRequestPathname,
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

  it("uses unversioned API roots as preset base URLs", () => {
    expect(PROVIDER_PRESET_BASE_URL).toEqual({
      openrouter: "https://openrouter.ai/api",
      openai: "https://api.openai.com",
      anthropic: "https://api.anthropic.com",
    });
    for (const baseUrl of Object.values(PROVIDER_PRESET_BASE_URL)) {
      expect(new URL(baseUrl).pathname).not.toMatch(/\/v1\/?$/u);
    }
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

describe("provider request path join", () => {
  it.each([
    // The regression: a documented `/v1` base must not produce `/v1/v1/...`.
    ["/v1", "/v1/chat/completions", "/v1/chat/completions"],
    ["/v1/", "/v1/chat/completions", "/v1/chat/completions"],
    ["/api/v1", "/v1/chat/completions", "/api/v1/chat/completions"],
    ["/v1", "/v1", "/v1"],
    // Unversioned roots and proxy prefixes keep the request's `/v1`.
    ["/", "/v1/chat/completions", "/v1/chat/completions"],
    ["", "/v1/messages", "/v1/messages"],
    ["/api", "/v1/chat/completions", "/api/v1/chat/completions"],
    ["/openai", "/v1/responses", "/openai/v1/responses"],
    ["/api/v1beta", "/v1/models", "/api/v1beta/v1/models"],
    ["/v10", "/v1/models", "/v10/v1/models"],
    // Request paths that are not `/v1/...` are never rewritten.
    ["/v1", "/models", "/v1/models"],
    ["/v1", "/v1beta/models", "/v1/v1beta/models"],
    ["/v1", "models", "/v1/models"],
  ])("joins base %s with %s as %s", (base, request, expected) => {
    expect(providerRequestPathname(base, request)).toBe(expected);
  });
});

describe("credential probe", () => {
  const accept = { accept: "application/json" };

  it.each([
    ["openrouter", "https://openrouter.ai/api", "https://openrouter.ai/api/v1/key"],
    ["OpenRouter", "https://openrouter.ai/api/", "https://openrouter.ai/api/v1/key"],
    [
      "openrouter",
      "https://gateway.example/openrouter",
      "https://gateway.example/openrouter/v1/key",
    ],
    ["openai", "https://api.openai.com", "https://api.openai.com/v1/models"],
    // Stored accounts from the old `/v1` form default keep working.
    ["openai", "https://api.openai.com/v1", "https://api.openai.com/v1/models"],
    ["openai", "https://gateway.example/openai", "https://gateway.example/openai/v1/models"],
  ])("probes the authenticated endpoint for %s at %s", (providerType, baseUrl, expected) => {
    expect(providerCredentialProbe(providerType, baseUrl)).toEqual({
      url: expected,
      headers: accept,
      verifiesCredential: true,
    });
  });

  it.each([
    ["https://api.anthropic.com", "https://api.anthropic.com/v1/models"],
    ["https://api.anthropic.com/v1/", "https://api.anthropic.com/v1/models"],
  ])("probes Anthropic's model list with anthropic-version at %s", (baseUrl, expected) => {
    expect(providerCredentialProbe("anthropic", baseUrl)).toEqual({
      url: expected,
      headers: { ...accept, "anthropic-version": ANTHROPIC_DEFAULT_API_VERSION },
      verifiesCredential: true,
    });
  });

  it("stays on the account's own origin", () => {
    for (const [type, baseUrl] of [
      ["openrouter", "https://openrouter.ai/api"],
      ["openai", "https://api.openai.com"],
      ["anthropic", "https://api.anthropic.com"],
      ["openai-compatible", "https://gateway.example/v1"],
      ["anthropic-compatible", "https://gateway.example"],
    ] as const) {
      expect(new URL(providerCredentialProbe(type, baseUrl).url).origin).toBe(
        new URL(baseUrl).origin,
      );
    }
  });

  // A compatible gateway's root may be a public landing/health page, so the
  // root is never probed; the family's model list is, but cannot verify.
  it.each([
    ["openai-compatible", "https://gateway.example", "https://gateway.example/v1/models", accept],
    [
      "openai-compatible",
      "https://gateway.example/v1",
      "https://gateway.example/v1/models",
      accept,
    ],
    [
      "anthropic-compatible",
      "https://gateway.example/anthropic",
      "https://gateway.example/anthropic/v1/models",
      { ...accept, "anthropic-version": ANTHROPIC_DEFAULT_API_VERSION },
    ],
  ])(
    "probes the conventional model list for %s at %s without claiming verification",
    (providerType, baseUrl, expected, headers) => {
      expect(providerCredentialProbe(providerType, baseUrl)).toEqual({
        url: expected,
        headers,
        verifiesCredential: false,
      });
    },
  );

  it("never verifies an unknown type (refused before egress anyway)", () => {
    expect(providerCredentialProbe("unknown", "https://provider.example/v1")).toEqual({
      url: "https://provider.example/v1",
      headers: accept,
      verifiesCredential: false,
    });
  });

  it("leaves an invalid base URL for the egress layer to reject", () => {
    expect(providerCredentialProbe("openrouter", "not a url").url).toBe("not a url");
  });
});

describe("credential probe classification", () => {
  const success = { ok: true, outcome: "SUCCESS", reason: null };
  const refused = { ok: false, outcome: "FAILURE", reason: "INVALID_CREDENTIAL" };
  const failed = { ok: false, outcome: "FAILURE", reason: "UNEXPECTED_STATUS" };
  const unverified = { ok: false, outcome: "INCONCLUSIVE", reason: "UNVERIFIED" };
  const inconclusive = { ok: false, outcome: "INCONCLUSIVE", reason: "UNEXPECTED_STATUS" };

  it.each([
    [200, success, unverified],
    [204, success, unverified],
    [401, refused, refused],
    [403, refused, refused],
    [404, failed, inconclusive],
    [421, failed, inconclusive],
    [429, failed, inconclusive],
    [500, failed, inconclusive],
    [101, failed, inconclusive],
    [null, failed, inconclusive],
  ] as const)(
    "classifies %s (verifying endpoint, unverifying endpoint)",
    (status, verifying, unverifying) => {
      expect(classifyCredentialProbeStatus(status, true)).toEqual(verifying);
      expect(classifyCredentialProbeStatus(status, false)).toEqual(unverifying);
    },
  );
});
