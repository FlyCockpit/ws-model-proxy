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
