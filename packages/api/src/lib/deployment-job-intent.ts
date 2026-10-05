import { z } from "zod";
import { embeddingContractSchema } from "./embedding-contract";

/** Durable execution identity shared by admission and every reconciler effect. No defaults. */
export const deploymentJobIntentSchema = z
  .object({
    type: z.literal("deployment.job"),
    attachment: z.enum(["llm", "embeddings"]),
    engine: z.enum(["vllm", "sglang", "llama.cpp", "other"]),
    management: z.enum(["ownedProcess", "externalService"]),
    embeddingContract: embeddingContractSchema.optional(),
    instanceId: z.string().min(1),
    revisionId: z.string().min(1),
    rank: z.number().int().min(0).max(63),
    action: z.enum(["prepare", "start", "after_join", "readiness", "health", "stop", "status"]),
    command: z.string(),
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
  });

/** Only action, command and action deadline may change; all immutable local identity survives. */
export function originalDeploymentStopIntent(value: unknown) {
  const original = deploymentJobIntentSchema.parse(value);
  return {
    ...original,
    action: "stop" as const,
    command: original.stopCommand,
    timeoutMs: 300_000,
  };
}

/** Periodic health reuses the rank's start identity with its own command and deadline. */
export function deploymentHealthIntent(value: unknown) {
  const start = deploymentJobIntentSchema.parse(value);
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
