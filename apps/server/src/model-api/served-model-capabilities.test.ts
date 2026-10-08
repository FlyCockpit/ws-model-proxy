import { describe, expect, it } from "vitest";

import { servedModelCapabilities } from "./served-model-capabilities.js";
import type { TranscriptionRequestProfile } from "./transcription-request.js";
import { transcriptionCapabilityCompatible } from "./transcription-request.js";

const french: TranscriptionRequestProfile = {
  stream: true,
  timestampGranularities: [],
  diarizationRequested: false,
  languageHints: ["fr"],
};

describe("servedModelCapabilities", () => {
  it("routes transcriptions by the profile the runtime definition declares", () => {
    const capabilities = servedModelCapabilities({
      capabilities: [],
      embeddingContract: null,
      transcriptionProfile: {
        streaming: true,
        languages: ["fr"],
        realtime: { adapter: "segmented" },
      },
    });
    expect(capabilities.audio?.transcriptions).toEqual({
      supported: true,
      streaming: true,
      languages: ["fr"],
      realtime: { supported: true, adapter: "segmented" },
    });
    const transcriptions = capabilities.audio?.transcriptions;
    expect(
      typeof transcriptions === "object" &&
        transcriptionCapabilityCompatible({ capability: transcriptions, request: french }),
    ).toBe(true);
  });

  it("keeps a model without a profile on the coarse flags", () => {
    const capabilities = servedModelCapabilities({
      capabilities: ["AUDIO_INPUT", "AUDIO_OUTPUT"],
      embeddingContract: null,
      transcriptionProfile: null,
    });
    expect(capabilities.version).toBe(1);
    expect(capabilities.audio).toEqual({ transcriptions: true, speech: true });
  });

  it("keeps speech next to a declared profile", () => {
    const capabilities = servedModelCapabilities({
      capabilities: ["AUDIO_OUTPUT"],
      embeddingContract: null,
      transcriptionProfile: { languages: ["fr"] },
    });
    expect(capabilities.audio).toEqual({
      transcriptions: { supported: true, languages: ["fr"] },
      speech: true,
    });
  });
});
