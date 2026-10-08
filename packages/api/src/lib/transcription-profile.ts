import { z } from "zod";

import { specIssue } from "./spec-issues";

/** A short capability token (language code, response format, MIME type). */
const profileToken = z.string().regex(/^[A-Za-z0-9_.+/-]{1,64}$/);

/**
 * How the CLI bridges a live `/v1/realtime` transcription session to the engine:
 * `vllm` speaks vLLM's own `/v1/realtime` protocol (deltas while the person speaks);
 * `segmented` sends each committed turn to the endpoint's file transcription route.
 */
export const REALTIME_TRANSCRIPTION_ADAPTERS = ["vllm", "segmented"] as const;

/** `RelayRequest.operation` of a live `/v1/realtime` transcription session. */
export const REALTIME_TRANSCRIPTION_OPERATION = "audio.realtime_transcription";
export type RealtimeTranscriptionAdapter = (typeof REALTIME_TRANSCRIPTION_ADAPTERS)[number];

/** Bounds shared with the CLI (`RealtimeTranscriptionProfile` in `apps/cli/src/deployments/mod.rs`). */
export const REALTIME_MAX_ITEM_SECONDS_MIN = 5;
export const REALTIME_MAX_ITEM_SECONDS_MAX = 600;
/** The segmented adapter buffers a whole turn in memory, so its turns are shorter. */
export const REALTIME_SEGMENTED_MAX_ITEM_SECONDS_MAX = 120;
export const REALTIME_MAX_SESSIONS_MAX = 8;
/** Used when a profile omits `maxItemSeconds`. */
export const REALTIME_DEFAULT_MAX_ITEM_SECONDS: Record<RealtimeTranscriptionAdapter, number> = {
  vllm: 300,
  segmented: 30,
};

const realtimeShape = {
  adapter: z.enum(REALTIME_TRANSCRIPTION_ADAPTERS),
  /** A turn longer than this is ended for the client (there is no voice activity detection). */
  maxItemSeconds: z
    .number()
    .int()
    .min(REALTIME_MAX_ITEM_SECONDS_MIN)
    .max(REALTIME_MAX_ITEM_SECONDS_MAX)
    .optional(),
  /** Live sessions this endpoint accepts at once (the CLI also caps all endpoints together). */
  maxSessions: z.number().int().min(1).max(REALTIME_MAX_SESSIONS_MAX).optional(),
};

function segmentedItemBound(
  value: { adapter: RealtimeTranscriptionAdapter; maxItemSeconds?: number },
  ctx: z.RefinementCtx,
) {
  if (
    value.adapter === "segmented" &&
    value.maxItemSeconds !== undefined &&
    value.maxItemSeconds > REALTIME_SEGMENTED_MAX_ITEM_SECONDS_MAX
  )
    ctx.addIssue({
      code: "custom",
      path: ["maxItemSeconds"],
      ...specIssue("segmentedMaxSeconds", { maxSeconds: REALTIME_SEGMENTED_MAX_ITEM_SECONDS_MAX }),
    });
}

/**
 * Opt-in live transcription. Absent means the endpoint takes no `/v1/realtime` sessions;
 * a recipe author sets it only when the engine serves vLLM's realtime route (`vllm`) or
 * its file route handles short turns well (`segmented`).
 */
export const realtimeTranscriptionProfileSchema = z
  .object(realtimeShape)
  .strict()
  .superRefine(segmentedItemBound)
  .describe(
    'Optional live transcription (/v1/realtime). {"adapter":"vllm"} for a vLLM realtime model (Voxtral realtime, Qwen3-ASR realtime); {"adapter":"segmented","maxItemSeconds":30} for any engine whose /v1/audio/transcriptions handles short turns. maxItemSeconds 5-600 (segmented at most 120), maxSessions 1-8.',
  );

/** The advertised form in endpoint capabilities: the profile plus `supported`. */
export const realtimeTranscriptionCapabilitiesSchema = z
  .object({ supported: z.boolean().optional(), ...realtimeShape })
  .strict()
  .superRefine(segmentedItemBound);

export type RealtimeTranscriptionProfile = z.infer<typeof realtimeTranscriptionProfileSchema>;

/** The turn length a session enforces for this profile. */
export function realtimeMaxItemSeconds(
  realtime: Pick<RealtimeTranscriptionProfile, "adapter" | "maxItemSeconds">,
): number {
  return realtime.maxItemSeconds ?? REALTIME_DEFAULT_MAX_ITEM_SECONDS[realtime.adapter];
}

/**
 * What a recipe-deployed speech-to-text server accepts beyond plain JSON
 * requests, advertised so requests using these options (a language hint,
 * verbose_json, word timestamps, ...) route to it. Bounded so the deployment
 * job frame stays small.
 */
export const transcriptionProfileSchema = z
  .object({
    streaming: z.boolean().optional(),
    responseFormats: z.array(profileToken).max(8).optional(),
    timestampGranularities: z.array(profileToken).max(4).optional(),
    diarization: z.boolean().optional(),
    languages: z.array(profileToken).max(128).optional(),
    languageDetection: z.boolean().optional(),
    multipleLanguageHints: z.boolean().optional(),
    maxUploadBytes: z
      .number()
      .int()
      .positive()
      .max(2 ** 31 - 1)
      .optional(),
    acceptedMimeTypes: z.array(profileToken).max(16).optional(),
    realtime: realtimeTranscriptionProfileSchema.optional(),
  })
  .strict();
