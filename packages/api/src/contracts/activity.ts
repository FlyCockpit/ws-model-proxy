import { z } from "zod";
import {
  ACTOR,
  idSchema,
  isoDateSchema,
  NODE_COMMAND_STATE,
  NODE_TRUST,
  noInputSchema,
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

/**
 * One row of the command log (lane D, contract addition pending review): a command an agent or
 * person ran on a node (`NodeCommand`, kept 30 days). No command text and no output here; the
 * output tail comes live from the node through `nodes.commands.get`.
 */
export const commandLogRowSchema = z
  .object({
    commandId: z.string(),
    nodeId: idSchema,
    nodeSlug: z.string(),
    actor: z.enum(ACTOR),
    agentTokenId: idSchema.nullable(),
    /** Display only: the agent token's name. */
    agentTokenName: z.string().nullable(),
    /** The allowlisted program name (`?` when unknown); never the command text. */
    program: z.string(),
    state: z.enum(NODE_COMMAND_STATE),
    exitCode: z.number().int().nullable(),
    startedAt: isoDateSchema,
    endsBy: isoDateSchema,
    finishedAt: isoDateSchema.nullable(),
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
  commands: {
    list: query(
      "session",
      z
        .object({
          nodeId: idSchema.optional(),
          state: z.enum(NODE_COMMAND_STATE).optional(),
          ...pageInputShape,
        })
        .strict(),
      pageOf(commandLogRowSchema),
      "Command log: commands agents and people ran on your nodes, running ones first by start time (no text, no output).",
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
      noInputSchema,
      z.object({ items: z.array(needsYouItemSchema), queuedCommands: z.number().int() }).strict(),
      "Everything waiting for a person: interactive steps, restarts, Forget; queued agent commands.",
    ),
  },
} as const;
