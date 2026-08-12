/**
 * Shared OpenAI-compatible capability metadata schema and transformer modality
 * resolution. Used by model-api runtime and pool management so validation paths
 * cannot drift.
 */
import { z } from "zod";

const booleanSupportSchema = z.boolean().optional();

export const openAiCompatibleCapabilitiesSchema = z
  .object({
    version: z.literal(1),
    protocol: z.literal("openai-compatible"),
    models: z
      .object({
        list: booleanSupportSchema,
      })
      .strict()
      .optional(),
    chatCompletions: z
      .object({
        supported: booleanSupportSchema,
        streaming: booleanSupportSchema,
        vision: booleanSupportSchema,
        video: booleanSupportSchema,
        audio: booleanSupportSchema,
      })
      .strict()
      .optional(),
    completions: z
      .object({
        supported: booleanSupportSchema,
        streaming: booleanSupportSchema,
      })
      .strict()
      .optional(),
    embeddings: z
      .object({
        supported: booleanSupportSchema,
      })
      .strict()
      .optional(),
    responses: z
      .object({
        supported: booleanSupportSchema,
        streaming: booleanSupportSchema,
        statefulFollowUps: booleanSupportSchema,
        retrieve: booleanSupportSchema,
        delete: booleanSupportSchema,
        cancel: booleanSupportSchema,
        listInputItems: booleanSupportSchema,
        countTokens: booleanSupportSchema,
        compact: booleanSupportSchema,
      })
      .strict()
      .optional(),
    audio: z
      .object({
        transcriptions: booleanSupportSchema,
        translations: booleanSupportSchema,
        speech: booleanSupportSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

export type OpenAiCompatibleCapabilities = z.infer<typeof openAiCompatibleCapabilitiesSchema>;

export type TransformerModalities = {
  images: boolean;
  audio: boolean;
  video: boolean;
};

export function parseOpenAiCompatibleCapabilities(
  value: unknown,
): OpenAiCompatibleCapabilities | null {
  const parsed = openAiCompatibleCapabilitiesSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Resolve effective capability metadata the same way model-api does:
 * OVERRIDE with parseable model metadata wins; if override mode is set but
 * metadata is missing/malformed, fall back to endpoint defaults. INHERIT uses
 * endpoint metadata only.
 */
export function resolveEffectiveCapabilityMetadata({
  capabilityOverrideMode,
  capabilityOverrideMetadata,
  endpointCapabilityMetadata,
}: {
  capabilityOverrideMode: string;
  capabilityOverrideMetadata: unknown | null | undefined;
  endpointCapabilityMetadata: unknown | null | undefined;
}): OpenAiCompatibleCapabilities | null {
  if (capabilityOverrideMode === "OVERRIDE") {
    const modelMetadata = parseOpenAiCompatibleCapabilities(capabilityOverrideMetadata);
    if (modelMetadata) return modelMetadata;
  }
  return parseOpenAiCompatibleCapabilities(endpointCapabilityMetadata);
}

export function openAiCapabilitiesFromCoarse(
  coarse: readonly string[],
): OpenAiCompatibleCapabilities {
  const text = coarse.includes("TEXT_GENERATION");
  const vision = coarse.includes("VISION_INPUT");
  const video = coarse.includes("VIDEO_INPUT");
  const audioInput = coarse.includes("AUDIO_INPUT");
  const audioOutput = coarse.includes("AUDIO_OUTPUT");
  const embedding = coarse.includes("EMBEDDING");
  const responses = coarse.includes("RESPONSES_API");
  return {
    version: 1,
    protocol: "openai-compatible",
    models: { list: true },
    ...(text || vision || video || audioInput
      ? {
          chatCompletions: {
            supported: true,
            streaming: true,
            vision,
            video,
            audio: audioInput,
          },
        }
      : {}),
    ...(embedding ? { embeddings: { supported: true } } : {}),
    ...(responses ? { responses: { supported: true, streaming: true } } : {}),
    ...(audioInput || audioOutput
      ? {
          audio: {
            ...(audioInput ? { transcriptions: true } : {}),
            ...(audioOutput ? { speech: true } : {}),
          },
        }
      : {}),
  };
}

export function supportsChatCompletions({
  capabilities,
  coarse,
}: {
  capabilities: OpenAiCompatibleCapabilities | null | undefined;
  coarse?: readonly string[] | null;
}): boolean {
  if (capabilities) {
    return capabilities.chatCompletions?.supported === true;
  }
  return Array.isArray(coarse) && coarse.includes("TEXT_GENERATION");
}

export function transformerSupportedModalities(
  capabilities: OpenAiCompatibleCapabilities | null | undefined,
): TransformerModalities {
  const chat = capabilities?.chatCompletions;
  if (!chat || chat.supported !== true) {
    return { images: false, audio: false, video: false };
  }
  return {
    images: chat.vision === true,
    video: chat.video === true,
    audio: chat.audio === true,
  };
}

export function effectiveTransformModalities({
  pool,
  transformerCaps,
}: {
  pool: TransformerModalities;
  transformerCaps: TransformerModalities;
}): TransformerModalities {
  return {
    images: pool.images && transformerCaps.images,
    audio: pool.audio && transformerCaps.audio,
    video: pool.video && transformerCaps.video,
  };
}

export function transformerModalityMismatchErrors({
  pool,
  transformerCaps,
}: {
  pool: TransformerModalities;
  transformerCaps: TransformerModalities;
}): string[] {
  const errors: string[] = [];
  if (pool.images && !transformerCaps.images) {
    errors.push("Transformer model does not support image/vision input.");
  }
  if (pool.audio && !transformerCaps.audio) {
    errors.push("Transformer model does not support audio input.");
  }
  if (pool.video && !transformerCaps.video) {
    errors.push("Transformer model does not support video input.");
  }
  return errors;
}

export function anyTransformModalityEnabled(m: TransformerModalities): boolean {
  return m.images || m.audio || m.video;
}
