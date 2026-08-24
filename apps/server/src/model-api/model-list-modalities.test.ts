import { describe, expect, it } from "vitest";
import type { OpenAiCompatibleCapabilities } from "../relay/protocol.js";
import {
  multimodalFlagsFromCapabilities,
  openAiModelListExtensions,
  openAiModelListExtensionsFromCapabilities,
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
      vision: true,
      video_input: true,
      audio_input: true,
      audio_output: false,
      audio_transcription: true,
      audio_translation: false,
    });
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
