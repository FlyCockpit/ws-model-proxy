import { resolveExecutionPath } from "@ws-model-proxy/api/lib/surface-capabilities";
import { describe, expect, it } from "vitest";

import { profileSurfaceRequest } from "./request-feature-profiler.js";
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
  it("passes function tools to a native local Chat endpoint with unknown tool support", () => {
    const capabilities = servedModelCapabilities({ capabilities: ["TEXT_GENERATION"] });
    const request = profileSurfaceRequest({
      tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
      parallel_tool_calls: false,
    });
    expect(request).toEqual({ tools: true });
    expect(
      resolveExecutionPath({
        capabilities,
        requestedSurface: "OPENAI_CHAT_COMPLETIONS",
        request,
      }).mode,
    ).toBe("native");
  });

  it("passes implicit parallel tool requests to a native local Chat endpoint", () => {
    const capabilities = servedModelCapabilities({ capabilities: ["TEXT_GENERATION"] });
    const request = profileSurfaceRequest({
      tools: [{ type: "function", function: { name: "lookup" } }],
    });
    expect(request).toEqual({ tools: true, parallelTools: true });
    expect(
      resolveExecutionPath({
        capabilities,
        requestedSurface: "OPENAI_CHAT_COMPLETIONS",
        request,
      }).mode,
    ).toBe("native");
  });

  it("routes transcriptions by the profile the runtime definition declares", () => {
    const capabilities = servedModelCapabilities({
      capabilities: [],
      type: "TRANSCRIPTION",
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
      type: "TRANSCRIPTION",
      embeddingContract: null,
      transcriptionProfile: { languages: ["fr"] },
    });
    expect(capabilities.audio).toEqual({
      transcriptions: { supported: true, languages: ["fr"] },
      speech: true,
    });
  });

  it("ignores a profile left on a model that is no longer a transcription model", () => {
    const capabilities = servedModelCapabilities({
      capabilities: ["TEXT_GENERATION"],
      type: "LLM",
      embeddingContract: null,
      transcriptionProfile: { languages: ["fr"], realtime: { adapter: "segmented" } },
    });
    expect(capabilities.version).toBe(1);
    expect(capabilities.audio).toBeUndefined();
  });
});

describe("declared tool and reasoning support", () => {
  const toolRequest = profileSurfaceRequest({
    tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
    parallel_tool_calls: false,
  });
  const path = (
    capabilities: ReturnType<typeof servedModelCapabilities>,
    requestedSurface: "OPENAI_CHAT_COMPLETIONS" | "OPENAI_RESPONSES",
    request = toolRequest,
  ) => resolveExecutionPath({ capabilities, requestedSurface, request }).mode;

  it("puts the declarations on Chat Completions and Responses", () => {
    const capabilities = servedModelCapabilities({
      capabilities: ["TEXT_GENERATION", "RESPONSES_API"],
      tools: true,
      reasoning: false,
    });
    expect(capabilities).toMatchObject({
      chatCompletions: { supported: true, tools: true, reasoning: false },
      responses: { supported: true, tools: true, reasoning: false },
    });
  });

  it("leaves undeclared (null) support unknown", () => {
    const capabilities = servedModelCapabilities({
      capabilities: ["TEXT_GENERATION"],
      tools: null,
      reasoning: null,
    });
    expect(capabilities.version === 1 && capabilities.chatCompletions).toEqual({
      supported: true,
      streaming: true,
      vision: false,
      video: false,
      audio: false,
    });
    expect(path(capabilities, "OPENAI_CHAT_COMPLETIONS")).toBe("native");
  });

  it("keeps tool requests off a model declared without tools", () => {
    const declined = servedModelCapabilities({ capabilities: ["TEXT_GENERATION"], tools: false });
    expect(path(declined, "OPENAI_CHAT_COMPLETIONS")).toBe("unavailable");
    // A request without tools still reaches it.
    expect(path(declined, "OPENAI_CHAT_COMPLETIONS", {})).toBe("native");
    const declared = servedModelCapabilities({ capabilities: ["TEXT_GENERATION"], tools: true });
    expect(path(declared, "OPENAI_CHAT_COMPLETIONS")).toBe("native");
  });

  it("keeps reasoning requests off a model declared without reasoning", () => {
    const request = profileSurfaceRequest({ reasoning: { effort: "high" } });
    expect(request).toMatchObject({ reasoning: true });
    const declined = servedModelCapabilities({
      capabilities: ["TEXT_GENERATION", "RESPONSES_API"],
      reasoning: false,
    });
    expect(path(declined, "OPENAI_RESPONSES", request)).toBe("unavailable");
    const unknown = servedModelCapabilities({ capabilities: ["TEXT_GENERATION", "RESPONSES_API"] });
    expect(path(unknown, "OPENAI_RESPONSES", request)).toBe("native");
  });

  it("keeps the declarations on a transcription model's version 2 capabilities", () => {
    const capabilities = servedModelCapabilities({
      capabilities: ["TEXT_GENERATION"],
      type: "TRANSCRIPTION",
      transcriptionProfile: { streaming: true },
      tools: false,
    });
    expect(capabilities.version).toBe(2);
    expect(capabilities.version === 2 && capabilities.chatCompletions?.tools).toBe(false);
  });
});
