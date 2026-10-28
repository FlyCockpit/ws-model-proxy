import { describe, expect, it } from "vitest";
import { effectiveModelCapabilities, typeDefaultCapabilities } from "./runtime-model-capabilities";

describe("effectiveModelCapabilities", () => {
  const model = {
    type: "EMBEDDINGS" as const,
    detectedCapabilities: [] as ("EMBEDDING" | "TEXT_GENERATION")[],
    capabilities: [] as ("EMBEDDING" | "TEXT_GENERATION")[],
    capabilitiesOverridden: false,
  };

  it("serves a model with nothing declared as its type, like the node", () => {
    expect(effectiveModelCapabilities(model)).toEqual(["EMBEDDING"]);
    expect(effectiveModelCapabilities({ ...model, type: "TRANSCRIPTION" })).toEqual([
      "AUDIO_INPUT",
    ]);
    expect(effectiveModelCapabilities({ ...model, type: "LLM" })).toEqual(["TEXT_GENERATION"]);
  });

  it("keeps what was detected, and the owner's override even when it is empty", () => {
    expect(
      effectiveModelCapabilities({ ...model, detectedCapabilities: ["TEXT_GENERATION"] }),
    ).toEqual(["TEXT_GENERATION"]);
    expect(
      effectiveModelCapabilities({
        ...model,
        detectedCapabilities: ["EMBEDDING"],
        capabilitiesOverridden: true,
      }),
    ).toEqual([]);
  });

  it("names one capability per type", () => {
    for (const type of ["LLM", "EMBEDDINGS", "TRANSCRIPTION"] as const)
      expect(typeDefaultCapabilities(type)).toHaveLength(1);
  });
});
