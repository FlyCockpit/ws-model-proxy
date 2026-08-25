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

import { audioOperationSupported } from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
import type { OpenAiCompatibleCapabilities } from "../relay/protocol.js";

export type ModelInputModality = "text" | "image" | "audio" | "video" | "file";
export type ModelOutputModality = "text" | "image" | "audio";

export type ModelListCapabilitiesAdvertisement = {
  vision: boolean;
  video_input: boolean;
  audio_input: boolean;
  audio_output: boolean;
  audio_transcription: boolean;
  audio_translation: boolean;
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
  /** Chat-completions `input_audio`; dedicated audio operations are separate. */
  audioInput: boolean;
  audioOutput: boolean;
  audioTranscription: boolean;
  audioTranslation: boolean;
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
      audioTranscription: false,
      audioTranslation: false,
    };
  }

  if (capabilities.version === 3 || capabilities.version === 4) {
    const surfaces = Object.values(capabilities.surfaces).filter(
      (surface): surface is NonNullable<typeof surface> => surface !== undefined,
    );
    const enabledSurfaces = surfaces.filter((surface) =>
      "operations" in surface ? surface.operations.includes("create") : surface.supported === true,
    );
    const legacyAudio = capabilities.version === 3 ? capabilities.audio : undefined;
    const audioTranscription = audioOperationSupported(legacyAudio?.transcriptions) === true;
    const audioTranslation = audioOperationSupported(legacyAudio?.translations) === true;
    return {
      text: enabledSurfaces.length > 0,
      vision: enabledSurfaces.some((surface) => surface.inputImages === true),
      video: enabledSurfaces.some((surface) => surface.inputVideo === true),
      audioInput: enabledSurfaces.some((surface) => surface.inputAudio === true),
      audioOutput:
        enabledSurfaces.some((surface) => surface.outputAudio === true) ||
        legacyAudio?.speech === true,
      audioTranscription,
      audioTranslation,
    };
  }

  const chat = capabilities.chatCompletions;
  const text = Boolean(
    chat?.supported || capabilities.completions?.supported || capabilities.responses?.supported,
  );
  const vision = chat?.vision === true;
  const video = chat?.video === true;
  const audioInput = chat?.audio === true;
  const audioTranscription = audioOperationSupported(capabilities.audio?.transcriptions) === true;
  const audioTranslation = audioOperationSupported(capabilities.audio?.translations) === true;
  const audioOutput = capabilities.audio?.speech === true;

  // Embedding-only models still accept text input; keep text true if embeddings.
  const textOrEmbed = text || capabilities.embeddings?.supported === true;

  return {
    text:
      textOrEmbed ||
      (!vision &&
        !video &&
        !audioInput &&
        !audioOutput &&
        !audioTranscription &&
        !audioTranslation),
    vision,
    video,
    audioInput,
    audioOutput,
    audioTranscription,
    audioTranslation,
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
      audioTranscription: acc.audioTranscription || next.audioTranscription,
      audioTranslation: acc.audioTranslation || next.audioTranslation,
    }),
    {
      text: false,
      vision: false,
      video: false,
      audioInput: false,
      audioOutput: false,
      audioTranscription: false,
      audioTranslation: false,
    },
  );
}

export function inputModalitiesFromFlags(flags: MultimodalFlags): ModelInputModality[] {
  const input: ModelInputModality[] = [];
  if (flags.text) input.push("text");
  if (flags.vision) input.push("image");
  if (flags.audioInput || flags.audioTranscription || flags.audioTranslation) input.push("audio");
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
  supports_audio_transcription: boolean;
  supports_audio_translation: boolean;
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
    supports_audio_transcription: flags.audioTranscription,
    supports_audio_translation: flags.audioTranslation,
    capabilities: {
      vision: flags.vision,
      video_input: flags.video,
      audio_input: flags.audioInput,
      audio_output: flags.audioOutput,
      audio_transcription: flags.audioTranscription,
      audio_translation: flags.audioTranslation,
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
