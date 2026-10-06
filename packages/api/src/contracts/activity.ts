import { z } from "zod";
import {
  idSchema,
  isoDateSchema,
  NODE_TRUST,
  OPERATOR_NEED,
  pageInputShape,
  pageOf,
  REQUEST_SOURCE,
  REQUEST_STATUS,
} from "./common";
import { metricsQueryInputSchema, metricsQueryOutputSchema } from "./metrics";
import { mutation, query } from "./procedure";

export const requestRowSchema = z
  .object({
    id: idSchema,
    createdAt: isoDateSchema,
    source: z.enum(REQUEST_SOURCE),
    status: z.enum(REQUEST_STATUS),
    poolId: idSchema.nullable(),
    callableId: z.string().nullable(),
    external: z.boolean(),
    operation: z.string().nullable(),
    route: z.enum(["local", "cloud", "own_key"]).nullable(),
    instanceId: idSchema.nullable(),
    versionId: idSchema.nullable(),
    nodeId: idSchema.nullable(),
    providerModelId: idSchema.nullable(),
    queueWaitMs: z.number().int().nullable(),
    ttftMs: z.number().int().nullable(),
    durationMs: z.number().int().nullable(),
    promptTokens: z.number().int().nullable(),
    completionTokens: z.number().int().nullable(),
    cacheReadTokens: z.number().int().nullable(),
    rejection: z.string().nullable(),
    errorClass: z.string().nullable(),
    httpStatusCode: z.number().int().nullable(),
    attempts: z.number().int(),
  })
  .strict();

export const needsYouItemSchema = z
  .object({
    need: z.enum(OPERATOR_NEED),
    instanceId: idSchema,
    runtimeId: idSchema,
    runtimeName: z.string(),
    nodeId: idSchema.nullable(),
    since: isoDateSchema,
    /** For STEP: the step to attach to (`runtimes.steps.attach`). */
    stepId: idSchema.nullable(),
  })
  .strict();

export const activityContract = {
  metrics: {
    query: query(
      "agent",
      metricsQueryInputSchema,
      metricsQueryOutputSchema,
      "Metrics over pools, runtimes, versions, nodes and instances, grouped by any rollup key.",
      ["metrics_query"],
    ),
  },
  requests: {
    list: query(
      "agent",
      z
        .object({
          poolId: idSchema.optional(),
          runtimeId: idSchema.optional(),
          versionId: idSchema.optional(),
          nodeId: idSchema.optional(),
          status: z.enum(REQUEST_STATUS).optional(),
          source: z.enum(REQUEST_SOURCE).optional(),
          since: isoDateSchema.optional(),
          ...pageInputShape,
        })
        .strict(),
      pageOf(requestRowSchema),
      "Request log (prompt-free): route, target, queue wait, TTFT, tokens, rejection, error class.",
      ["requests_list"],
    ),
    delete: mutation(
      "human",
      z
        .object({
          ids: z.array(idSchema).max(500).optional(),
          before: isoDateSchema.optional(),
        })
        .strict()
        .refine((input) => (input.ids === undefined) !== (input.before === undefined), {
          message: "Give ids or before.",
        }),
      z.object({ deleted: z.number().int() }).strict(),
      "Delete request log rows.",
    ),
  },
  overview: {
    summary: query(
      "session",
      z.object({ range: z.enum(["24h", "7d"]).default("24h") }).strict(),
      z
        .object({
          kpis: z
            .object({
              requests: z.number().int(),
              errors: z.number().int(),
              p95LatencyMs: z.number().nullable(),
              p95TtftMs: z.number().nullable(),
              p95QueueWaitMs: z.number().nullable(),
              cloudShare: z.number().nullable(),
            })
            .strict(),
          nodes: z.array(
            z
              .object({
                id: idSchema,
                slug: z.string(),
                online: z.boolean(),
                trust: z.enum(NODE_TRUST),
              })
              .strict(),
          ),
          pools: z.array(
            z
              .object({
                id: idSchema,
                callableId: z.string(),
                requests: z.number().int(),
                errors: z.number().int(),
                sparkline: z.array(z.number().int()),
              })
              .strict(),
          ),
          onboarding: z
            .object({
              done: z.boolean(),
              steps: z
                .object({
                  node: z.boolean(),
                  runtime: z.boolean(),
                  pool: z.boolean(),
                  agent: z.boolean(),
                  apiKey: z.boolean(),
                })
                .strict(),
            })
            .strict(),
        })
        .strict(),
      "Overview KPIs (agent tests excluded), nodes strip, pool cards, getting-started state.",
    ),
  },
  needsYou: {
    list: query(
      "session",
      z.object({}).strict(),
      z.object({ items: z.array(needsYouItemSchema), queuedCommands: z.number().int() }).strict(),
      "Everything waiting for a person: interactive steps, restarts, Forget; queued agent commands.",
    ),
  },
} as const;
