import { describe, expect, it } from "vitest";
import type { OpenAiCompatibleCapabilities } from "../relay/protocol.js";
import {
  externalModelListFlags,
  multimodalFlagsFromCapabilities,
  openAiModelListExtensions,
  openAiModelListExtensionsFromCapabilities,
  poolModelListFlags,
  unionMultimodalFlags,
} from "./model-list-modalities.js";

function caps(
  partial: Partial<Omit<Extract<OpenAiCompatibleCapabilities, { version: 1 }>, "version">> & {
    chatCompletions?: OpenAiCompatibleCapabilities["chatCompletions"];
    audio?: OpenAiCompatibleCapabilities["audio"];
  },
): OpenAiCompatibleCapabilities {
  return {
    version: 1,
    protocol: "openai-compatible",
    ...partial,
  };
}

describe("multimodalFlagsFromCapabilities", () => {
  it("defaults to text-only when capabilities are missing", () => {
    expect(multimodalFlagsFromCapabilities(null)).toEqual({
      text: true,
      vision: false,
      video: false,
      audioInput: false,
      audioOutput: false,
      audioTranscription: false,
      audioTranslation: false,
    });
  });

  it("maps chat vision/video/audio and dedicated audio endpoints", () => {
    expect(
      multimodalFlagsFromCapabilities(
        caps({
          chatCompletions: {
            supported: true,
            streaming: true,
            vision: true,
            video: true,
            audio: true,
          },
          audio: { speech: true },
        }),
      ),
    ).toEqual({
      text: true,
      vision: true,
      video: true,
      audioInput: true,
      audioOutput: true,
      audioTranscription: false,
      audioTranslation: false,
    });
  });

  it("advertises dedicated audio operations separately from chat input_audio", () => {
    const flags = multimodalFlagsFromCapabilities(
      caps({
        chatCompletions: { supported: true },
        audio: { transcriptions: true, translations: true },
      }),
    );
    expect(flags.audioInput).toBe(false);
    expect(flags.audioTranscription).toBe(true);
    expect(flags.audioTranslation).toBe(true);
    const ext = openAiModelListExtensions(flags);
    expect(ext.supports_audio_input).toBe(false);
    expect(ext.supports_audio_transcription).toBe(true);
    expect(ext.supports_audio_translation).toBe(true);
    expect(ext.architecture.input_modalities).toContain("audio");
  });
});

function v2Audio(
  audio: Extract<OpenAiCompatibleCapabilities, { version: 2 }>["audio"],
): OpenAiCompatibleCapabilities {
  return { version: 2, protocol: "openai-compatible", audio };
}

describe("live transcription advertisement", () => {
  it("flags only audio.transcriptions.realtime with supported: true", () => {
    const realtime = { supported: true, adapter: "segmented" as const };
    const live = openAiModelListExtensionsFromCapabilities(
      v2Audio({ transcriptions: { supported: true, realtime } }),
    );
    expect(live.supports_realtime_transcription).toBe(true);
    expect(live.capabilities.realtime_transcription).toBe(true);
    const translationsOnly = openAiModelListExtensionsFromCapabilities(
      v2Audio({ translations: { supported: true, realtime } }),
    );
    expect(translationsOnly.supports_realtime_transcription).toBe(false);
    const notSupported = openAiModelListExtensionsFromCapabilities(
      v2Audio({ transcriptions: { supported: true, realtime: { ...realtime, supported: false } } }),
    );
    expect(notSupported.supports_realtime_transcription).toBe(false);
    expect(
      unionMultimodalFlags([
        multimodalFlagsFromCapabilities(v2Audio({ transcriptions: { supported: true } })),
        multimodalFlagsFromCapabilities(v2Audio({ transcriptions: { supported: true, realtime } })),
      ]).realtimeTranscription,
    ).toBe(true);
  });
});

describe("openAiModelListExtensions", () => {
  it("emits OpenRouter-style architecture and LM Studio-style capability flags", () => {
    const ext = openAiModelListExtensions({
      text: true,
      vision: true,
      video: true,
      audioInput: true,
      audioOutput: false,
      audioTranscription: true,
      audioTranslation: false,
    });
    expect(ext.supports_vision).toBe(true);
    expect(ext.supports_video_input).toBe(true);
    expect(ext.supports_audio_input).toBe(true);
    expect(ext.capabilities).toEqual({
      embeddings: false,
      vision: true,
      video_input: true,
      audio_input: true,
      audio_output: false,
      audio_transcription: true,
      audio_translation: false,
      realtime_transcription: false,
    });
    expect(ext.supports_realtime_transcription).toBe(false);
    expect(ext.architecture.input_modalities).toEqual(["text", "image", "audio", "video"]);
    expect(ext.architecture.output_modalities).toEqual(["text"]);
    expect(ext.architecture.modality).toBe("text+image+audio+video->text");
  });

  it("advertises text-only for bare chat defaults", () => {
    const ext = openAiModelListExtensionsFromCapabilities(
      caps({ chatCompletions: { supported: true, streaming: true } }),
    );
    expect(ext.supports_vision).toBe(false);
    expect(ext.architecture.input_modalities).toEqual(["text"]);
    expect(ext.architecture.modality).toBe("text->text");
  });
});

describe("unionMultimodalFlags", () => {
  it("ORs pool member capabilities", () => {
    expect(
      unionMultimodalFlags([
        {
          text: true,
          vision: true,
          video: false,
          audioInput: false,
          audioOutput: false,
          audioTranscription: true,
          audioTranslation: false,
        },
        {
          text: true,
          vision: false,
          video: true,
          audioInput: true,
          audioOutput: false,
          audioTranscription: false,
          audioTranslation: true,
        },
      ]),
    ).toEqual({
      text: true,
      vision: true,
      video: true,
      audioInput: true,
      audioOutput: false,
      audioTranscription: true,
      audioTranslation: true,
    });
  });
});

describe("poolModelListFlags", () => {
  const row = (id: string, capabilities: string[], active = true) => ({
    active,
    model: { id, capabilities },
  });

  it("advertises a text-only wrap as text only", () => {
    const flags = poolModelListFlags([row("glm", ["TEXT_GENERATION"])]);
    expect(openAiModelListExtensions(flags)).toMatchObject({
      supports_vision: false,
      supports_video_input: false,
      architecture: { input_modalities: ["text"] },
    });
  });

  it("ignores a disabled member's capabilities, and unions the active ones", () => {
    const disabledVision = row(
      "qwen-vl",
      ["TEXT_GENERATION", "VISION_INPUT", "VIDEO_INPUT"],
      false,
    );
    expect(poolModelListFlags([row("glm", ["TEXT_GENERATION"]), disabledVision])).toMatchObject({
      vision: false,
      video: false,
    });
    expect(
      poolModelListFlags([row("glm", ["TEXT_GENERATION"]), { ...disabledVision, active: true }]),
    ).toMatchObject({ vision: true, video: true });
  });

  it("advertises speech-to-text, live included, from the runtime's transcription profile", () => {
    const flags = poolModelListFlags([
      {
        model: {
          id: "voxtral",
          capabilities: [],
          type: "TRANSCRIPTION",
          transcriptionProfile: { realtime: { adapter: "segmented", maxItemSeconds: 30 } },
        },
      },
    ]);
    expect(openAiModelListExtensions(flags)).toMatchObject({
      supports_audio_transcription: true,
      supports_realtime_transcription: true,
    });
    expect(openAiModelListExtensions(externalModelListFlags(flags))).toMatchObject({
      supports_audio_transcription: true,
      supports_realtime_transcription: false,
    });
  });
});

describe("declared tool and reasoning advertisement", () => {
  const row = (id: string, tools?: boolean | null, reasoning?: boolean | null, active = true) => ({
    active,
    model: { id, capabilities: ["TEXT_GENERATION"], tools, reasoning },
  });

  it("omits the fields while support is unknown", () => {
    const ext = openAiModelListExtensions(poolModelListFlags([row("a"), row("b", null, null)]));
    expect(ext).not.toHaveProperty("supports_tools");
    expect(ext).not.toHaveProperty("supports_reasoning");
    expect(ext.capabilities).not.toHaveProperty("tools");
    expect(ext.capabilities).not.toHaveProperty("reasoning");
  });

  it("advertises a pool as taking tools when any active member does", () => {
    const ext = openAiModelListExtensions(
      poolModelListFlags([row("a", false), row("b"), row("c", true, false)]),
    );
    expect(ext).toMatchObject({ supports_tools: true, capabilities: { tools: true } });
    // b's reasoning is unknown, so the pool's is too.
    expect(ext).not.toHaveProperty("supports_reasoning");
  });

  it("advertises false only when every active member is declared false", () => {
    const flags = poolModelListFlags([row("a", false, false), row("b", false, false)]);
    expect(openAiModelListExtensions(flags)).toMatchObject({
      supports_tools: false,
      supports_reasoning: false,
      capabilities: { tools: false, reasoning: false },
    });
    // An inactive member that takes tools does not count.
    const withInactive = poolModelListFlags([row("a", false), row("b", true, null, false)]);
    expect(openAiModelListExtensions(withInactive)).toMatchObject({ supports_tools: false });
  });

  it("does not carry local declarations to the :external entry", () => {
    const flags = poolModelListFlags([row("a", true, true)]);
    const ext = openAiModelListExtensions(externalModelListFlags(flags));
    expect(ext).not.toHaveProperty("supports_tools");
    expect(ext).not.toHaveProperty("supports_reasoning");
  });
});
