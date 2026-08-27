/**
 * Shared OpenAI-compatible capability metadata schema and transformer modality
 * resolution. Used by model-api runtime and pool management so validation paths
 * cannot drift.
 */
import { z } from "zod";
import { reasoningConfigSchema, validateSurfaceReasoningConfig } from "./reasoning-contract";

const booleanSupportSchema = z.boolean().optional();

export const transcriptionCapabilitiesSchema = z
  .object({
    supported: booleanSupportSchema,
    streaming: booleanSupportSchema,
    responseFormats: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
    timestampGranularities: z.array(z.string().trim().min(1).max(64)).max(16).optional(),
    diarization: booleanSupportSchema,
    languages: z.array(z.string().trim().min(1).max(64)).max(256).optional(),
    languageDetection: booleanSupportSchema,
    multipleLanguageHints: booleanSupportSchema,
    maxUploadBytes: z
      .number()
      .int()
      .positive()
      .max(2 ** 31 - 1)
      .optional(),
    acceptedMimeTypes: z.array(z.string().trim().min(1).max(255)).max(128).optional(),
  })
  .strict();

export type TranscriptionCapabilities = z.infer<typeof transcriptionCapabilitiesSchema>;
const commonCapabilityShape = {
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
} as const;

const v1CapabilitiesSchema = z
  .object({
    version: z.literal(1),
    ...commonCapabilityShape,
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

const v2CapabilitiesSchema = z
  .object({
    version: z.literal(2),
    ...commonCapabilityShape,
    audio: z
      .object({
        transcriptions: transcriptionCapabilitiesSchema.optional(),
        translations: transcriptionCapabilitiesSchema.optional(),
        speech: booleanSupportSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

const baseSurfaceFeatureSchema = z
  .object({
    source: z.enum(["declared", "probe", "dashboard", "provider"]),
    confidence: z.enum(["exact", "high", "estimated", "unknown"]),
    supported: booleanSupportSchema,
    streaming: booleanSupportSchema,
    maxContextTokens: z.number().int().positive().optional(),
    inputImages: booleanSupportSchema,
    outputImages: booleanSupportSchema,
    inputAudio: booleanSupportSchema,
    outputAudio: booleanSupportSchema,
    inputVideo: booleanSupportSchema,
    outputVideo: booleanSupportSchema,
    tools: booleanSupportSchema,
    parallelTools: booleanSupportSchema,
    structuredOutput: booleanSupportSchema,
    reasoning: booleanSupportSchema,
    reasoningConfig: reasoningConfigSchema.optional(),
    hostedTools: booleanSupportSchema,
    protocolVersion: z.string().trim().min(1).max(64).optional(),
    betaFeatures: z.array(z.string().trim().min(1).max(128)).max(64).optional(),
  })
  .strict();

const surfaceFeatureSchema = baseSurfaceFeatureSchema.superRefine((value, context) =>
  validateSurfaceReasoningConfig(value, "openaiChatCompletions", context),
);

const completionsSurfaceFeatureSchema = baseSurfaceFeatureSchema.superRefine((value, context) =>
  validateSurfaceReasoningConfig(value, "openaiCompletions", context),
);

const anthropicSurfaceFeatureSchema = baseSurfaceFeatureSchema
  .extend({ countTokens: booleanSupportSchema })
  .superRefine((value, context) =>
    validateSurfaceReasoningConfig(value, "anthropicMessages", context),
  );

const responsesSurfaceFeatureSchema = baseSurfaceFeatureSchema
  .extend({
    responsesLifecycle: z
      .object({
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
  })
  .superRefine((value, context) =>
    validateSurfaceReasoningConfig(value, "openaiResponses", context),
  );

const capabilityOperationSchema = {
  openaiChatCompletions: z.enum(["create"]),
  openaiResponses: z.enum([
    "create",
    "statefulFollowUps",
    "retrieve",
    "delete",
    "cancel",
    "listInputItems",
    "countTokens",
    "compact",
  ]),
  anthropicMessages: z.enum(["create", "countTokens"]),
  openaiCompletions: z.enum(["create"]),
} as const;

function uniqueOperations<T extends z.ZodTypeAny>(operation: T) {
  return z
    .array(operation)
    .min(1)
    .max(16)
    .refine((operations) => new Set(operations).size === operations.length, {
      message: "Capability operations must be unique.",
    });
}

const v4SurfaceFeatureShape = {
  source: z.enum(["declared", "probe", "dashboard", "provider"]),
  confidence: z.enum(["exact", "high", "estimated", "unknown"]),
  streaming: booleanSupportSchema,
  maxContextTokens: z.number().int().positive().optional(),
  inputImages: booleanSupportSchema,
  outputImages: booleanSupportSchema,
  inputAudio: booleanSupportSchema,
  outputAudio: booleanSupportSchema,
  inputVideo: booleanSupportSchema,
  outputVideo: booleanSupportSchema,
  tools: booleanSupportSchema,
  parallelTools: booleanSupportSchema,
  structuredOutput: booleanSupportSchema,
  reasoning: booleanSupportSchema,
  reasoningConfig: reasoningConfigSchema.optional(),
  hostedTools: booleanSupportSchema,
} as const;

const anthropicProtocolVersionSchema = z
  .object({
    version: z.string().trim().min(1).max(64),
    betaFeatures: z
      .array(z.string().trim().min(1).max(128))
      .max(64)
      .refine((betas) => new Set(betas).size === betas.length, {
        message: "Anthropic beta features must be unique.",
      })
      .default([]),
  })
  .strict();

const v4CapabilitiesSchema = z
  .object({
    version: z.literal(4),
    protocol: z.enum(["openai-compatible", "anthropic-compatible"]),
    models: z.never().optional(),
    chatCompletions: z.never().optional(),
    completions: z.never().optional(),
    embeddings: z.never().optional(),
    responses: z.never().optional(),
    audio: z.never().optional(),
    surfaces: z
      .object({
        openaiChatCompletions: z
          .object({
            ...v4SurfaceFeatureShape,
            operations: uniqueOperations(capabilityOperationSchema.openaiChatCompletions),
          })
          .strict()
          .superRefine((value, context) =>
            validateSurfaceReasoningConfig(value, "openaiChatCompletions", context),
          )
          .optional(),
        openaiResponses: z
          .object({
            ...v4SurfaceFeatureShape,
            operations: uniqueOperations(capabilityOperationSchema.openaiResponses),
          })
          .strict()
          .superRefine((value, context) =>
            validateSurfaceReasoningConfig(value, "openaiResponses", context),
          )
          .optional(),
        anthropicMessages: z
          .object({
            ...v4SurfaceFeatureShape,
            operations: uniqueOperations(capabilityOperationSchema.anthropicMessages),
            protocolVersions: z
              .array(anthropicProtocolVersionSchema)
              .min(1)
              .max(16)
              .refine(
                (versions) =>
                  new Set(versions.map(({ version }) => version)).size === versions.length,
                { message: "Anthropic protocol versions must be unique." },
              ),
          })
          .strict()
          .superRefine((value, context) =>
            validateSurfaceReasoningConfig(value, "anthropicMessages", context),
          )
          .optional(),
        openaiCompletions: z
          .object({
            ...v4SurfaceFeatureShape,
            operations: uniqueOperations(capabilityOperationSchema.openaiCompletions),
          })
          .strict()
          .superRefine((value, context) =>
            validateSurfaceReasoningConfig(value, "openaiCompletions", context),
          )
          .optional(),
      })
      .strict(),
    source: z.enum(["declared", "probe", "dashboard", "provider"]).optional(),
    confidence: z.enum(["exact", "high", "estimated", "unknown"]).optional(),
  })
  .strict()
  .superRefine((inventory, context) => {
    const hasAnthropic = inventory.surfaces.anthropicMessages !== undefined;
    const hasOpenAi =
      inventory.surfaces.openaiChatCompletions !== undefined ||
      inventory.surfaces.openaiResponses !== undefined ||
      inventory.surfaces.openaiCompletions !== undefined;
    if (inventory.protocol === "openai-compatible" && hasAnthropic)
      context.addIssue({
        code: "custom",
        message: "OpenAI-compatible inventories cannot declare Anthropic surfaces.",
        path: ["surfaces", "anthropicMessages"],
      });
    if (inventory.protocol === "anthropic-compatible" && hasOpenAi)
      context.addIssue({
        code: "custom",
        message: "Anthropic-compatible inventories cannot declare OpenAI surfaces.",
        path: ["surfaces"],
      });
  });

/**
 * Version 3 is the provider-independent inventory. The legacy operation fields
 * remain present so v1/v2 readers and non-generation routes can be migrated
 * independently without losing their existing meaning.
 */
const v3CapabilitiesSchema = z
  .object({
    version: z.literal(3),
    ...commonCapabilityShape,
    protocol: z.enum(["openai-compatible", "anthropic-compatible"]),
    surfaces: z
      .object({
        openaiChatCompletions: surfaceFeatureSchema.optional(),
        openaiResponses: responsesSurfaceFeatureSchema.optional(),
        anthropicMessages: anthropicSurfaceFeatureSchema.optional(),
        openaiCompletions: completionsSurfaceFeatureSchema.optional(),
      })
      .strict(),
    source: z.enum(["declared", "probe", "dashboard", "provider"]).optional(),
    confidence: z.enum(["exact", "high", "estimated", "unknown"]).optional(),
    audio: z
      .object({
        transcriptions: transcriptionCapabilitiesSchema.optional(),
        translations: transcriptionCapabilitiesSchema.optional(),
        speech: booleanSupportSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

export const openAiCompatibleCapabilitiesSchema = z.discriminatedUnion("version", [
  v1CapabilitiesSchema,
  v2CapabilitiesSchema,
  v3CapabilitiesSchema,
  v4CapabilitiesSchema,
]);

export type OpenAiCompatibleCapabilities = z.infer<typeof openAiCompatibleCapabilitiesSchema>;

export function normalizeTranscriptionCapabilities(
  value: boolean | TranscriptionCapabilities | null | undefined,
): TranscriptionCapabilities | undefined {
  if (typeof value === "boolean") return { supported: value };
  return value ?? undefined;
}

export function audioOperationSupported(
  value: boolean | TranscriptionCapabilities | null | undefined,
): boolean | undefined {
  return typeof value === "boolean" ? value : value?.supported;
}

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

/** Derive the legacy routing index without losing the richer v2 metadata. */
export function coarseCapabilitiesFromOpenAi(
  capabilities: OpenAiCompatibleCapabilities,
): Array<
  | "TEXT_GENERATION"
  | "VISION_INPUT"
  | "AUDIO_INPUT"
  | "AUDIO_OUTPUT"
  | "VIDEO_INPUT"
  | "EMBEDDING"
  | "RESPONSES_API"
> {
  const coarse: ReturnType<typeof coarseCapabilitiesFromOpenAi> = [];
  if (capabilities.version === 4) {
    const surfaces = capabilities.surfaces;
    if (
      surfaces.openaiChatCompletions?.operations.includes("create") ||
      surfaces.openaiCompletions?.operations.includes("create") ||
      surfaces.openaiResponses?.operations.includes("create") ||
      surfaces.anthropicMessages?.operations.includes("create")
    )
      coarse.push("TEXT_GENERATION");
    if (surfaces.openaiChatCompletions?.inputImages) coarse.push("VISION_INPUT");
    if (surfaces.openaiChatCompletions?.inputAudio) coarse.push("AUDIO_INPUT");
    if (surfaces.openaiChatCompletions?.inputVideo) coarse.push("VIDEO_INPUT");
    if (surfaces.openaiChatCompletions?.outputAudio) coarse.push("AUDIO_OUTPUT");
    if (surfaces.openaiResponses?.operations.includes("create")) coarse.push("RESPONSES_API");
    return coarse;
  }
  if (
    capabilities.chatCompletions?.supported === true ||
    capabilities.completions?.supported === true ||
    capabilities.responses?.supported === true
  )
    coarse.push("TEXT_GENERATION");
  if (capabilities.chatCompletions?.vision === true) coarse.push("VISION_INPUT");
  if (capabilities.chatCompletions?.audio === true) coarse.push("AUDIO_INPUT");
  if (capabilities.chatCompletions?.video === true) coarse.push("VIDEO_INPUT");
  if (
    audioOperationSupported(capabilities.audio?.transcriptions) === true ||
    audioOperationSupported(capabilities.audio?.translations) === true
  ) {
    if (!coarse.includes("AUDIO_INPUT")) coarse.push("AUDIO_INPUT");
  }
  if (capabilities.audio?.speech === true) coarse.push("AUDIO_OUTPUT");
  if (capabilities.embeddings?.supported === true) coarse.push("EMBEDDING");
  if (capabilities.responses?.supported === true) coarse.push("RESPONSES_API");
  return coarse;
}

export function supportsChatCompletions({
  capabilities,
  coarse,
}: {
  capabilities: OpenAiCompatibleCapabilities | null | undefined;
  coarse?: readonly string[] | null;
}): boolean {
  if (capabilities) {
    if (capabilities.version === 4)
      return capabilities.surfaces.openaiChatCompletions?.operations.includes("create") === true;
    return capabilities.chatCompletions?.supported === true;
  }
  return Array.isArray(coarse) && coarse.includes("TEXT_GENERATION");
}

export function transformerSupportedModalities(
  capabilities: OpenAiCompatibleCapabilities | null | undefined,
): TransformerModalities {
  if (capabilities?.version === 4) {
    const surface = capabilities.surfaces.openaiChatCompletions;
    if (!surface?.operations.includes("create"))
      return { images: false, audio: false, video: false };
    return {
      images: surface.inputImages === true,
      audio: surface.inputAudio === true,
      video: surface.inputVideo === true,
    };
  }
  const chat = capabilities?.chatCompletions;
  if (chat?.supported !== true) {
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
