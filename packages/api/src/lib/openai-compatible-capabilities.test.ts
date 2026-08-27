import { describe, expect, it } from "vitest";
import {
  normalizeTranscriptionCapabilities,
  openAiCapabilitiesFromCoarse,
  parseOpenAiCompatibleCapabilities,
  resolveEffectiveCapabilityMetadata,
  supportsChatCompletions,
  transformerSupportedModalities,
} from "./openai-compatible-capabilities";

const endpointCaps = {
  version: 1 as const,
  protocol: "openai-compatible" as const,
  chatCompletions: { supported: true, streaming: true, vision: true },
};

const overrideVisionFalse = {
  version: 1 as const,
  protocol: "openai-compatible" as const,
  chatCompletions: { supported: true, streaming: true, vision: false },
};

describe("resolveEffectiveCapabilityMetadata", () => {
  it("uses parseable OVERRIDE metadata when present", () => {
    const caps = resolveEffectiveCapabilityMetadata({
      capabilityOverrideMode: "OVERRIDE",
      capabilityOverrideMetadata: overrideVisionFalse,
      endpointCapabilityMetadata: endpointCaps,
    });
    expect(transformerSupportedModalities(caps).images).toBe(false);
  });

  it("falls back to endpoint defaults when OVERRIDE metadata is malformed", () => {
    const caps = resolveEffectiveCapabilityMetadata({
      capabilityOverrideMode: "OVERRIDE",
      capabilityOverrideMetadata: { not: "valid", chatCompletions: { vision: true } },
      endpointCapabilityMetadata: endpointCaps,
    });
    expect(caps).toEqual(endpointCaps);
    expect(transformerSupportedModalities(caps).images).toBe(true);
  });

  it("falls back to endpoint defaults when OVERRIDE metadata is null", () => {
    const caps = resolveEffectiveCapabilityMetadata({
      capabilityOverrideMode: "OVERRIDE",
      capabilityOverrideMetadata: null,
      endpointCapabilityMetadata: endpointCaps,
    });
    expect(transformerSupportedModalities(caps).images).toBe(true);
  });

  it("inherits endpoint metadata when not OVERRIDE", () => {
    const caps = resolveEffectiveCapabilityMetadata({
      capabilityOverrideMode: "INHERIT_ENDPOINT_DEFAULTS",
      capabilityOverrideMetadata: overrideVisionFalse,
      endpointCapabilityMetadata: endpointCaps,
    });
    expect(transformerSupportedModalities(caps).images).toBe(true);
  });
});

describe("supportsChatCompletions", () => {
  it("requires explicit chatCompletions.supported when metadata is parseable", () => {
    expect(
      supportsChatCompletions({
        capabilities: {
          version: 1,
          protocol: "openai-compatible",
          embeddings: { supported: true },
        },
      }),
    ).toBe(false);
    expect(
      supportsChatCompletions({
        capabilities: {
          version: 1,
          protocol: "openai-compatible",
          chatCompletions: { supported: false },
        },
      }),
    ).toBe(false);
    expect(supportsChatCompletions({ capabilities: endpointCaps })).toBe(true);
  });

  it("falls back to coarse TEXT_GENERATION when metadata is missing", () => {
    expect(supportsChatCompletions({ capabilities: null, coarse: ["EMBEDDING"] })).toBe(false);
    expect(supportsChatCompletions({ capabilities: null, coarse: ["TEXT_GENERATION"] })).toBe(true);
  });
});

describe("capability inventory v4", () => {
  const v4 = {
    version: 4,
    protocol: "openai-compatible",
    surfaces: {
      openaiChatCompletions: {
        source: "provider",
        confidence: "exact",
        operations: ["create"],
        inputImages: true,
      },
    },
  } as const;

  it("derives support from exact operations while retaining old readers", () => {
    const parsed = parseOpenAiCompatibleCapabilities(v4);
    expect(parsed?.version).toBe(4);
    expect(supportsChatCompletions({ capabilities: parsed })).toBe(true);
    expect(transformerSupportedModalities(parsed)).toEqual({
      images: true,
      audio: false,
      video: false,
    });
    expect(parseOpenAiCompatibleCapabilities(endpointCaps)?.version).toBe(1);
  });

  it("rejects unknown, duplicate, and legacy boolean operation declarations", () => {
    for (const operations of [["unknown"], ["create", "create"]]) {
      expect(
        parseOpenAiCompatibleCapabilities({
          ...v4,
          surfaces: { openaiChatCompletions: { ...v4.surfaces.openaiChatCompletions, operations } },
        }),
      ).toBeNull();
    }
    expect(
      parseOpenAiCompatibleCapabilities({
        ...v4,
        surfaces: {
          openaiChatCompletions: {
            ...v4.surfaces.openaiChatCompletions,
            supported: true,
          },
        },
      }),
    ).toBeNull();
  });
});

describe("reasoning capability contract", () => {
  const chat = {
    source: "provider",
    confidence: "exact",
    operations: ["create"],
    reasoning: true,
    reasoningConfig: { supportedLevels: ["none", "low"], defaultLevel: "low" },
  };

  it("accepts v3 and v4 reasoning config while retaining boolean-only inventories", () => {
    expect(
      parseOpenAiCompatibleCapabilities({
        version: 3,
        protocol: "openai-compatible",
        surfaces: {
          openaiChatCompletions: {
            source: "provider",
            confidence: "exact",
            supported: true,
            reasoning: true,
            reasoningConfig: chat.reasoningConfig,
          },
        },
      }),
    ).not.toBeNull();
    expect(
      parseOpenAiCompatibleCapabilities({
        version: 4,
        protocol: "openai-compatible",
        surfaces: { openaiChatCompletions: chat },
      }),
    ).not.toBeNull();
    expect(
      parseOpenAiCompatibleCapabilities({
        version: 4,
        protocol: "openai-compatible",
        surfaces: {
          openaiChatCompletions: {
            source: "provider",
            confidence: "exact",
            operations: ["create"],
            reasoning: true,
          },
        },
      }),
    ).not.toBeNull();
  });

  it("rejects incoherent and cross-family reasoning config", () => {
    const inventory = {
      version: 4,
      protocol: "openai-compatible",
      surfaces: { openaiChatCompletions: chat },
    };
    expect(
      parseOpenAiCompatibleCapabilities({
        ...inventory,
        surfaces: { openaiChatCompletions: { ...chat, reasoning: false } },
      }),
    ).toBeNull();
    expect(
      parseOpenAiCompatibleCapabilities({
        ...inventory,
        surfaces: { openaiChatCompletions: { ...chat, reasoningConfig: {} } },
      }),
    ).toBeNull();
    expect(
      parseOpenAiCompatibleCapabilities({
        ...inventory,
        surfaces: {
          openaiChatCompletions: {
            ...chat,
            reasoningConfig: { encoding: { kind: "anthropic_thinking" } },
          },
        },
      }),
    ).toBeNull();
  });
});

describe("openAiCapabilitiesFromCoarse", () => {
  it("preserves embeddings and responses while enabling vision", () => {
    const caps = openAiCapabilitiesFromCoarse([
      "TEXT_GENERATION",
      "VISION_INPUT",
      "EMBEDDING",
      "RESPONSES_API",
    ]);
    expect(caps.chatCompletions).toMatchObject({
      supported: true,
      vision: true,
      video: false,
      audio: false,
    });
    expect(caps.embeddings).toEqual({ supported: true });
    expect(caps.responses).toMatchObject({ supported: true });
  });
});

describe("detailed transcription capabilities", () => {
  it("enforces versioned audio operation shapes", () => {
    expect(
      parseOpenAiCompatibleCapabilities({
        version: 1,
        protocol: "openai-compatible",
        audio: { transcriptions: { supported: true } },
      }),
    ).toBeNull();
    expect(
      parseOpenAiCompatibleCapabilities({
        version: 2,
        protocol: "openai-compatible",
        audio: { transcriptions: true },
      }),
    ).toBeNull();
  });

  it("reads both legacy booleans and v2 profiles without changing unknown fields to false", () => {
    expect(normalizeTranscriptionCapabilities(true)).toEqual({ supported: true });
    expect(normalizeTranscriptionCapabilities(undefined)).toBeUndefined();
    expect(
      normalizeTranscriptionCapabilities({
        supported: true,
        streaming: true,
        responseFormats: ["json", "verbose_json"],
        timestampGranularities: [],
      }),
    ).toEqual({
      supported: true,
      streaming: true,
      responseFormats: ["json", "verbose_json"],
      timestampGranularities: [],
    });
  });
});

describe("v4 inventory invariants", () => {
  const anthropic = {
    version: 4,
    protocol: "anthropic-compatible",
    surfaces: {
      anthropicMessages: {
        source: "provider",
        confidence: "exact",
        operations: ["create"],
        protocolVersions: [{ version: "2023-06-01", betaFeatures: ["beta-one"] }],
      },
    },
  };

  it("rejects trimmed duplicate Anthropic versions and betas", () => {
    expect(
      parseOpenAiCompatibleCapabilities({
        ...anthropic,
        surfaces: {
          anthropicMessages: {
            ...anthropic.surfaces.anthropicMessages,
            protocolVersions: [{ version: "2023-06-01", betaFeatures: ["beta-one", " beta-one "] }],
          },
        },
      }),
    ).toBeNull();
    expect(
      parseOpenAiCompatibleCapabilities({
        ...anthropic,
        surfaces: {
          anthropicMessages: {
            ...anthropic.surfaces.anthropicMessages,
            protocolVersions: [
              { version: "2023-06-01", betaFeatures: [] },
              { version: " 2023-06-01 ", betaFeatures: [] },
            ],
          },
        },
      }),
    ).toBeNull();
  });

  it("rejects surfaces inconsistent with the declared protocol", () => {
    expect(
      parseOpenAiCompatibleCapabilities({ ...anthropic, protocol: "openai-compatible" }),
    ).toBeNull();
    expect(
      parseOpenAiCompatibleCapabilities({
        version: 4,
        protocol: "anthropic-compatible",
        surfaces: {
          openaiResponses: {
            source: "provider",
            confidence: "exact",
            operations: ["create"],
          },
        },
      }),
    ).toBeNull();
  });
});
