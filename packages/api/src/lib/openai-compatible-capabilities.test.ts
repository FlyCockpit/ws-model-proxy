import { describe, expect, it } from "vitest";
import {
  resolveEffectiveCapabilityMetadata,
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
