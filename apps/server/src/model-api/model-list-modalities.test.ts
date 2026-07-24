import { describe, expect, it } from "vitest";
import type { OpenAiCompatibleCapabilities } from "../relay/protocol.js";
import {
  multimodalFlagsFromCapabilities,
  openAiModelListExtensions,
  openAiModelListExtensionsFromCapabilities,
  unionMultimodalFlags,
} from "./model-list-modalities.js";

function caps(
  partial: Partial<OpenAiCompatibleCapabilities> & {
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
    });
  });

  it("treats transcriptions as audio input without requiring chat.audio", () => {
    expect(
      multimodalFlagsFromCapabilities(
        caps({
          chatCompletions: { supported: true },
          audio: { transcriptions: true },
        }),
      ).audioInput,
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
    });
    expect(ext.supports_vision).toBe(true);
    expect(ext.supports_video_input).toBe(true);
    expect(ext.supports_audio_input).toBe(true);
    expect(ext.capabilities).toEqual({
      vision: true,
      video_input: true,
      audio_input: true,
      audio_output: false,
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
        { text: true, vision: true, video: false, audioInput: false, audioOutput: false },
        { text: true, vision: false, video: true, audioInput: true, audioOutput: false },
      ]),
    ).toEqual({
      text: true,
      vision: true,
      video: true,
      audioInput: true,
      audioOutput: false,
    });
  });
});
