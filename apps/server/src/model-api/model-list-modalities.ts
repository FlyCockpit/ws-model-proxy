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
import { realtimeTranscriptionCapability } from "../relay/stt-relay.js";
import { servedModelCapabilities } from "./served-model-capabilities.js";

export type ModelInputModality = "text" | "image" | "audio" | "video" | "file";
export type ModelOutputModality = "text" | "image" | "audio" | "embedding";

export type ModelListCapabilitiesAdvertisement = {
  embeddings: boolean;
  vision: boolean;
  video_input: boolean;
  audio_input: boolean;
  audio_output: boolean;
  audio_transcription: boolean;
  audio_translation: boolean;
  /** Live `/v1/realtime?intent=transcription` sessions (a hint; routing decides). */
  realtime_transcription: boolean;
  /** Tool calls, when the owner declared them; absent is unknown. */
  tools?: boolean;
  /** Reasoning (thinking) controls, when the owner declared them; absent is unknown. */
  reasoning?: boolean;
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
  embeddings?: boolean;
  text: boolean;
  vision: boolean;
  video: boolean;
  /** Chat-completions `input_audio`; dedicated audio operations are separate. */
  audioInput: boolean;
  audioOutput: boolean;
  audioTranscription: boolean;
  audioTranslation: boolean;
  /**
   * The capability advertises live transcription (`audio.transcriptions.realtime`
   * with `supported: true`; never translations). Sessions still open only on a ready
   * instance whose target is healthy or not yet judged, and never on `:external`.
   */
  realtimeTranscription?: boolean;
  /**
   * Tool calls on a text surface: true when one takes them, false when every one is
   * declared without them, absent when unknown.
   */
  tools?: boolean;
  /** Reasoning controls, decided like `tools`. */
  reasoning?: boolean;
};

/** True when any is true, false when all are known and false, otherwise unknown. */
function anyKnown(values: ReadonlyArray<boolean | undefined>): boolean | undefined {
  if (values.some((value) => value === true)) return true;
  if (values.length > 0 && values.every((value) => value === false)) return false;
  return undefined;
}

function declaredFlags(
  surfaces: ReadonlyArray<{ tools?: boolean; reasoning?: boolean }>,
): Pick<MultimodalFlags, "tools" | "reasoning"> {
  const tools = anyKnown(surfaces.map((surface) => surface.tools));
  const reasoning = anyKnown(surfaces.map((surface) => surface.reasoning));
  return {
    ...(tools === undefined ? {} : { tools }),
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

function realtimeFlag(capabilities: OpenAiCompatibleCapabilities): {
  realtimeTranscription?: true;
} {
  return realtimeTranscriptionCapability(capabilities) ? { realtimeTranscription: true } : {};
}

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
    const legacyAudio = capabilities.audio;
    const audioTranscription = audioOperationSupported(legacyAudio?.transcriptions) === true;
    const audioTranslation = audioOperationSupported(legacyAudio?.translations) === true;
    return {
      ...(capabilities.embeddings?.supported === true ? { embeddings: true } : {}),
      text: enabledSurfaces.length > 0,
      vision: enabledSurfaces.some((surface) => surface.inputImages === true),
      video: enabledSurfaces.some((surface) => surface.inputVideo === true),
      audioInput: enabledSurfaces.some((surface) => surface.inputAudio === true),
      audioOutput:
        enabledSurfaces.some((surface) => surface.outputAudio === true) ||
        legacyAudio?.speech === true,
      audioTranscription,
      audioTranslation,
      ...realtimeFlag(capabilities),
      ...declaredFlags(enabledSurfaces),
    };
  }

  const chat = capabilities.chatCompletions;
  const text = Boolean(chat?.supported || capabilities.responses?.supported);
  const vision = chat?.vision === true;
  const video = chat?.video === true;
  const audioInput = chat?.audio === true;
  const audioTranscription = audioOperationSupported(capabilities.audio?.transcriptions) === true;
  const audioTranslation = audioOperationSupported(capabilities.audio?.translations) === true;
  const audioOutput = capabilities.audio?.speech === true;

  // Embedding-only models still accept text input; keep text true if embeddings.
  const embeddings = capabilities.embeddings?.supported === true;

  return {
    ...(embeddings ? { embeddings: true } : {}),
    text:
      text ||
      (!embeddings &&
        !vision &&
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
    ...realtimeFlag(capabilities),
    ...declaredFlags(
      [capabilities.chatCompletions, capabilities.responses].filter(
        (surface): surface is NonNullable<typeof surface> => surface?.supported === true,
      ),
    ),
  };
}

export function unionMultimodalFlags(flags: MultimodalFlags[]): MultimodalFlags {
  if (flags.length === 0) {
    return multimodalFlagsFromCapabilities(null);
  }
  const union = flags.reduce(
    (acc, next) => ({
      ...(acc.embeddings || next.embeddings ? { embeddings: true } : {}),
      text: acc.text || next.text,
      vision: acc.vision || next.vision,
      video: acc.video || next.video,
      audioInput: acc.audioInput || next.audioInput,
      audioOutput: acc.audioOutput || next.audioOutput,
      audioTranscription: acc.audioTranscription || next.audioTranscription,
      audioTranslation: acc.audioTranslation || next.audioTranslation,
      ...(acc.realtimeTranscription || next.realtimeTranscription
        ? { realtimeTranscription: true }
        : {}),
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
  // A pool takes tools when any member does; it is known not to only when every member is.
  return { ...union, ...declaredFlags(flags) };
}

/**
 * What `/v1/models` advertises for a pool: the union of its ACTIVE members' served-model
 * capabilities (the owner's override, else what the node detected), never a guess from the
 * model's name or a catalog. A disabled member (say a vision model switched off) does not
 * make the text-only members still serving look multimodal.
 */
export function poolModelListFlags(
  rows: ReadonlyArray<{
    active?: boolean;
    model: {
      id: string;
      capabilities: readonly string[];
      type?: string;
      embeddingContract?: unknown;
      transcriptionProfile?: unknown;
      tools?: boolean | null;
      reasoning?: boolean | null;
    };
  }>,
): MultimodalFlags {
  const byModel = new Map(
    rows.filter((row) => row.active !== false).map((row) => [row.model.id, row.model] as const),
  );
  return unionMultimodalFlags(
    [...byModel.values()].map((model) =>
      multimodalFlagsFromCapabilities(servedModelCapabilities(model)),
    ),
  );
}

/** The flags of a pool's `owner/pool:external` entry: live sessions never take `:external`. */
export function externalModelListFlags(flags: MultimodalFlags): MultimodalFlags {
  // A cloud member's tool and reasoning support is the provider's, not the local members'.
  const { tools: _tools, reasoning: _reasoning, ...rest } = flags;
  return { ...rest, realtimeTranscription: false };
}

export function inputModalitiesFromFlags(flags: MultimodalFlags): ModelInputModality[] {
  const input: ModelInputModality[] = [];
  if (flags.text || flags.embeddings) input.push("text");
  if (flags.vision) input.push("image");
  if (flags.audioInput || flags.audioTranscription || flags.audioTranslation) input.push("audio");
  if (flags.video) input.push("video");
  if (input.length === 0) input.push("text");
  return input;
}

export function outputModalitiesFromFlags(flags: MultimodalFlags): ModelOutputModality[] {
  const output: ModelOutputModality[] = flags.embeddings && !flags.text ? [] : ["text"];
  if (flags.embeddings) output.push("embedding");
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
  supports_realtime_transcription: boolean;
  supports_tools?: boolean;
  supports_reasoning?: boolean;
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
    supports_realtime_transcription: flags.realtimeTranscription === true,
    ...(flags.tools === undefined ? {} : { supports_tools: flags.tools }),
    ...(flags.reasoning === undefined ? {} : { supports_reasoning: flags.reasoning }),
    capabilities: {
      embeddings: flags.embeddings === true,
      vision: flags.vision,
      video_input: flags.video,
      audio_input: flags.audioInput,
      audio_output: flags.audioOutput,
      audio_transcription: flags.audioTranscription,
      audio_translation: flags.audioTranslation,
      realtime_transcription: flags.realtimeTranscription === true,
      ...(flags.tools === undefined ? {} : { tools: flags.tools }),
      ...(flags.reasoning === undefined ? {} : { reasoning: flags.reasoning }),
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
