import { z } from "zod";
import { embeddingContractSchema } from "./embedding-contract";
import { transcriptionProfileSchema } from "./transcription-profile";

/** Durable execution identity shared by admission and every reconciler effect. No defaults. */
export const deploymentJobIntentSchema = z
  .object({
    type: z.literal("deployment.job"),
    attachment: z.enum(["llm", "embeddings", "transcription"]),
    engine: z.enum(["vllm", "sglang", "llama.cpp", "other"]),
    management: z.enum(["ownedProcess", "externalService"]),
    embeddingContract: embeddingContractSchema.optional(),
    transcriptionProfile: transcriptionProfileSchema.optional(),
    instanceId: z.string().min(1),
    revisionId: z.string().min(1),
    rank: z.number().int().min(0).max(63),
    action: z.enum(["prepare", "start", "after_join", "readiness", "health", "stop", "status"]),
    command: z.string(),
    /** A person runs `command` in an operator terminal. Present only when true, so intents
     * without interactive commands (and their hashes) are unchanged. */
    interactive: z.literal(true).optional(),
    /** The rank's stop command is interactive; becomes `interactive` on the derived stop. */
    stopInteractive: z.literal(true).optional(),
    stopCommand: z.string().refine((s) => !!s.trim()),
    statusCommand: z.string().nullable().optional(),
    healthCommand: z.string().nullable().optional(),
    timeoutMs: z.number().int().min(1).max(900_000),
    unitName: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    endpointSlug: z.string().min(1),
    models: z.array(z.string().min(1)).min(1).max(64),
    contextWindow: z.number().int().positive().nullable(),
    readiness: z
      .object({ path: z.string(), expectedStatus: z.number(), timeoutMs: z.number().optional() })
      .strict(),
    health: z
      .object({
        intervalMs: z.number(),
        failureThreshold: z.number(),
        successThreshold: z.number(),
      })
      .strict(),
  })
  .strict()
  .superRefine((intent, ctx) => {
    if (intent.management === "externalService" && !intent.statusCommand?.trim())
      ctx.addIssue({
        code: "custom",
        path: ["statusCommand"],
        message: "External services require reliable status.",
      });
    if (intent.interactive && !["prepare", "start", "after_join", "stop"].includes(intent.action))
      ctx.addIssue({
        code: "custom",
        path: ["interactive"],
        message: "Only prepare, start and stop jobs can be interactive.",
      });
    if (
      intent.interactive &&
      intent.action !== "stop" &&
      intent.action !== "prepare" &&
      intent.management !== "externalService"
    )
      ctx.addIssue({
        code: "custom",
        path: ["management"],
        message: "An interactive start must be an external service.",
      });
    if ((intent.interactive || intent.stopInteractive) && !intent.statusCommand?.trim())
      ctx.addIssue({
        code: "custom",
        path: ["statusCommand"],
        message: "Interactive jobs require reliable status.",
      });
  });

/**
 * Only action, command, action deadline and whether a person runs the command may change; all
 * immutable local identity survives. The rank's `stopInteractive` becomes the stop's own
 * `interactive`.
 */
export function originalDeploymentStopIntent(value: unknown) {
  const {
    interactive: _interactive,
    stopInteractive,
    ...original
  } = deploymentJobIntentSchema.parse(value);
  return {
    ...original,
    ...(stopInteractive ? { interactive: true as const } : {}),
    action: "stop" as const,
    command: original.stopCommand,
    timeoutMs: 300_000,
  };
}

/**
 * Periodic health reuses the rank's start identity with its own command and deadline. Health
 * is never interactive, so both interactive flags are dropped.
 */
export function deploymentHealthIntent(value: unknown) {
  const {
    interactive: _interactive,
    stopInteractive: _stopInteractive,
    ...start
  } = deploymentJobIntentSchema.parse(value);
  return {
    ...start,
    action: "health" as const,
    command: start.healthCommand ?? "",
    timeoutMs: 30_000,
  };
}

/** Every job the reconciler can later derive from a persisted intent, including itself. */
export function deploymentDerivedIntents(value: unknown) {
  const intent = deploymentJobIntentSchema.parse(value);
  return intent.action === "start"
    ? [intent, originalDeploymentStopIntent(intent), deploymentHealthIntent(intent)]
    : [intent];
}
