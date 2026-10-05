import { z } from "zod";

/** A short capability token (language code, response format, MIME type). */
const profileToken = z.string().regex(/^[A-Za-z0-9_.+/-]{1,64}$/);

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
  })
  .strict();
