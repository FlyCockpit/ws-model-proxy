/**
 * De-facto multimodal advertisement for OpenAI-compatible `GET /v1/models`.
 *
 * Official OpenAI list objects only define id/created/object/owned_by. Gateways
 * (OpenRouter, LM Studio native list, various harnesses) commonly add:
 *   - `supports_vision` / boolean capability flags
 *   - `capabilities.{vision,audio_input,video_input,...}`
 *   - `architecture.{input_modalities,output_modalities,modality}`
 *
 * We emit those additively from stored OpenAiCompatibleCapabilities so agents
 * can auto-enable image/audio/video paste without a manual "vision" toggle.
 * Extra fields are ignored by strict OpenAI SDKs.
 */

import type { OpenAiCompatibleCapabilities } from "../relay/protocol.js";

export type ModelInputModality = "text" | "image" | "audio" | "video" | "file";
export type ModelOutputModality = "text" | "image" | "audio";

export type ModelListCapabilitiesAdvertisement = {
  vision: boolean;
  video_input: boolean;
  audio_input: boolean;
  audio_output: boolean;
};

export type ModelListArchitectureAdvertisement = {
  input_modalities: ModelInputModality[];
  output_modalities: ModelOutputModality[];
  /** OpenRouter-style summary, e.g. `text+image->text`. */
  modality: string;
};

/**
 * Flags derived from effective model capabilities (override or endpoint default).
 * Missing/null capabilities → text-only (safe default for listed chat models).
 */
export type MultimodalFlags = {
  text: boolean;
  vision: boolean;
  video: boolean;
  /** Chat `input_audio` and/or dedicated transcription/translation endpoints. */
  audioInput: boolean;
  audioOutput: boolean;
};

export function multimodalFlagsFromCapabilities(
  capabilities: OpenAiCompatibleCapabilities | null | undefined,
): MultimodalFlags {
  if (!capabilities) {
    return {
      text: true,
      vision: false,
      video: false,
      audioInput: false,
      audioOutput: false,
    };
  }

  const chat = capabilities.chatCompletions;
  const text = Boolean(
    chat?.supported || capabilities.completions?.supported || capabilities.responses?.supported,
  );
  const vision = chat?.vision === true;
  const video = chat?.video === true;
  const audioInput =
    chat?.audio === true ||
    capabilities.audio?.transcriptions === true ||
    capabilities.audio?.translations === true;
  const audioOutput = capabilities.audio?.speech === true;

  // Embedding-only models still accept text input; keep text true if embeddings.
  const textOrEmbed = text || capabilities.embeddings?.supported === true;

  return {
    text: textOrEmbed || (!vision && !video && !audioInput && !audioOutput),
    vision,
    video,
    audioInput,
    audioOutput,
  };
}

export function unionMultimodalFlags(flags: MultimodalFlags[]): MultimodalFlags {
  if (flags.length === 0) {
    return multimodalFlagsFromCapabilities(null);
  }
  return flags.reduce(
    (acc, next) => ({
      text: acc.text || next.text,
      vision: acc.vision || next.vision,
      video: acc.video || next.video,
      audioInput: acc.audioInput || next.audioInput,
      audioOutput: acc.audioOutput || next.audioOutput,
    }),
    {
      text: false,
      vision: false,
      video: false,
      audioInput: false,
      audioOutput: false,
    },
  );
}

export function inputModalitiesFromFlags(flags: MultimodalFlags): ModelInputModality[] {
  const input: ModelInputModality[] = [];
  if (flags.text) input.push("text");
  if (flags.vision) input.push("image");
  if (flags.audioInput) input.push("audio");
  if (flags.video) input.push("video");
  if (input.length === 0) input.push("text");
  return input;
}

export function outputModalitiesFromFlags(flags: MultimodalFlags): ModelOutputModality[] {
  const output: ModelOutputModality[] = ["text"];
  if (flags.audioOutput) output.push("audio");
  return output;
}

export function modalitySummary(
  input: readonly ModelInputModality[],
  output: readonly ModelOutputModality[],
): string {
  return `${input.join("+")}->${output.join("+")}`;
}

/**
 * Additive OpenAI-list fields for one model entry. Callers merge onto
 * `{ id, object, created, owned_by }`.
 */
export function openAiModelListExtensions(flags: MultimodalFlags): {
  supports_vision: boolean;
  supports_video_input: boolean;
  supports_audio_input: boolean;
  supports_audio_output: boolean;
  capabilities: ModelListCapabilitiesAdvertisement;
  architecture: ModelListArchitectureAdvertisement;
} {
  const input_modalities = inputModalitiesFromFlags(flags);
  const output_modalities = outputModalitiesFromFlags(flags);
  return {
    supports_vision: flags.vision,
    supports_video_input: flags.video,
    supports_audio_input: flags.audioInput,
    supports_audio_output: flags.audioOutput,
    capabilities: {
      vision: flags.vision,
      video_input: flags.video,
      audio_input: flags.audioInput,
      audio_output: flags.audioOutput,
    },
    architecture: {
      input_modalities,
      output_modalities,
      modality: modalitySummary(input_modalities, output_modalities),
    },
  };
}

export function openAiModelListExtensionsFromCapabilities(
  capabilities: OpenAiCompatibleCapabilities | null | undefined,
) {
  return openAiModelListExtensions(multimodalFlagsFromCapabilities(capabilities));
}
