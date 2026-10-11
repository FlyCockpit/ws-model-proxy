import { z } from "zod";
import { idSchema, MODEL_CAPABILITY, MODEL_TYPE, noInputSchema } from "./common";
import { mutation, query } from "./procedure";

/** `owner/pool` or `owner/pool:external`. */
export const callableIdSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62})\/[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,40}(?::external)?$/);

export const callableModelSchema = z
  .object({
    callableId: callableIdSchema,
    poolId: idSchema,
    external: z.boolean(),
    type: z.enum(MODEL_TYPE),
    owner: z.object({ slug: z.string(), you: z.boolean(), email: z.string().nullable() }).strict(),
    status: z.enum(["serving", "starting", "unavailable"]),
  })
  .strict();

/** The request APIs the web Test page can speak. */
export const TEST_SURFACES = [
  "OPENAI_CHAT_COMPLETIONS",
  "OPENAI_RESPONSES",
  "ANTHROPIC_MESSAGES",
] as const;

/**
 * One thing the web Test page can send to: a callable ID, or one of the caller's own served
 * models (direct, `runtime:<runtimeId>:<model>`, web and model_test only).
 */
export const testTargetSchema = z
  .object({
    /** The `model` the Test page's requests name. */
    model: z.string(),
    source: z.enum(["pool", "runtime"]),
    /** Pool: its callable ID. Runtime: the runtime's name. */
    label: z.string(),
    /** Runtime: the served model name; null for a pool. */
    servedModel: z.string().nullable(),
    runtimeId: idSchema.nullable(),
    type: z.enum(MODEL_TYPE),
    status: z.enum(["serving", "starting", "unavailable"]),
    external: z.boolean(),
    /** Pool: what any local member's served model can do. Runtime: the model's own. */
    capabilities: z.array(z.enum(MODEL_CAPABILITY)),
    /** Chat targets only: the request APIs this target answers (natively or adapted). */
    surfaces: z.array(z.enum(TEST_SURFACES)),
    recommendedSurface: z.enum(TEST_SURFACES).nullable(),
    /** A served model declares live (realtime) transcription. */
    liveTranscription: z.boolean(),
    /** The pool's per-attachment cap; null when it sets none. */
    maxAttachmentBytes: z.number().int().nullable(),
  })
  .strict();

export const modelTestTargetSchema = z.union([
  /** `owner/pool`; `:external` cannot be tested (refused). */
  z.object({ pool: callableIdSchema }).strict(),
  z
    .object({
      runtimeId: idSchema,
      /** Defaults to the runtime's first served model. */
      model: z.string().min(1).max(256).optional(),
      instanceId: idSchema.optional(),
    })
    .strict(),
]);

export const modelTestResultSchema = z
  .object({
    outcome: z.enum(["ok", "error", "refused"]),
    servedBy: z
      .object({
        instanceId: idSchema.nullable(),
        nodeId: idSchema.nullable(),
        versionId: idSchema.nullable(),
        providerModelId: idSchema.nullable(),
      })
      .strict(),
    ttftMs: z.number().nullable(),
    latencyMs: z.number().nullable(),
    queueWaitMs: z.number().nullable(),
    promptTokens: z.number().int().nullable(),
    completionTokens: z.number().int().nullable(),
    errorClass: z.string().nullable(),
    /** The runtime's own error message (redacted, one line) when it answered >= 400. */
    upstreamError: z.string().nullable(),
    /** Refusal reason (over_capacity, wait_expired, context_too_large, ...). */
    rejection: z.string().nullable(),
    /** A short excerpt of the answer (chat) or the transcript (transcription). */
    excerpt: z.string().nullable(),
  })
  .strict();

export const modelsContract = {
  list: query(
    "session",
    noInputSchema,
    z
      .object({
        /** Base URL for the OpenAI/Anthropic-compatible API (`/v1`). */
        baseUrl: z.string().url(),
        models: z.array(callableModelSchema),
      })
      .strict(),
    "Every callable ID you may use (own pools and pools shared with you with can use), except one an alias of yours hides.",
  ),
  testTargets: query(
    "session",
    noInputSchema,
    z.object({ targets: z.array(testTargetSchema) }).strict(),
    "What the web Test page can send to: your callable IDs and your runtimes' served models.",
  ),
  test: mutation(
    "agent",
    z
      .object({
        target: modelTestTargetSchema,
        kind: z.enum(["chat", "embeddings", "transcription"]).optional(),
        prompt: z.string().min(1).max(32_000).optional(),
        maxTokens: z.number().int().min(1).max(4_096).optional(),
        bench: z
          .object({
            repeat: z.number().int().min(1).max(50),
            concurrency: z.number().int().min(1).max(8),
            promptTokens: z.number().int().min(1).max(200_000).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        result: modelTestResultSchema,
        bench: z
          .object({
            rows: z.array(modelTestResultSchema),
            p50: z
              .object({ ttftMs: z.number().nullable(), latencyMs: z.number().nullable() })
              .strict(),
            p95: z
              .object({ ttftMs: z.number().nullable(), latencyMs: z.number().nullable() })
              .strict(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    "Send a test (source AGENT_TEST: metrics count it in tests, apart from load; a runtime test is not pool traffic). Transcription uses a built-in silent WAV. :external cannot be tested; benches run only on your own pools and runtimes.",
    ["model_test"],
  ),
} as const;
