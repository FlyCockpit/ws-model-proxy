/**
 * What an instance step carries (`InstanceStep.intent`, hashed into `intentHash`) and the
 * placeholder values its `runtime.job` frame sends. Shared by the server's dispatch
 * (`apps/server/src/runtimes/steps.ts` `jobFrame`) and the step views
 * (`runtime-views.ts`), so the command a person is shown is rendered from exactly the values
 * the node receives.
 */
import { z } from "zod";

export const stepIntentSchema = z
  .object({
    /** The operation the generation belongs to (a restart keeps it; null for probes). */
    operationId: z.string().nullable(),
    runtimeId: z.string(),
    launchVersionId: z.string(),
    launchHash: z.string(),
    rank: z.number().int().min(0).max(63),
    nnodes: z.number().int().min(1).max(64),
    handle: z.string(),
    unitName: z.string(),
    port: z.number().int(),
    distPort: z.number().int().nullable(),
    fabricId: z.string().nullable(),
    /** Placeholders other than head_addr (resolved from the fabric at dispatch). */
    placeholders: z.record(z.string(), z.union([z.string(), z.number()])),
    timeoutMs: z.number().int().min(1_000).max(86_400_000),
    /** The command of this phase runs in an operator terminal (a person must answer). */
    interactive: z.boolean(),
  })
  .strict();
export type StepIntent = z.infer<typeof stepIntentSchema>;

/** The `placeholders` object of a `runtime.job` frame (`jobPlaceholdersSchema`). */
export type StepJobPlaceholders = {
  port: number;
  dist_port?: number;
  head_addr?: string;
  gpu_ids?: string;
  memory_gb?: string;
  vram_gb?: string;
  memory_fraction?: string;
};

/**
 * The placeholder values a step's job sends: the intent's typed placeholders, plus
 * `head_addr` (the head rank's address on the instance's fabric, resolved at dispatch) for a
 * multi-node step.
 */
export function stepJobPlaceholders(
  intent: StepIntent,
  headAddr: string | null,
): StepJobPlaceholders {
  const placeholders: StepJobPlaceholders = { port: intent.port };
  for (const [key, value] of Object.entries(intent.placeholders)) {
    if (key === "dist_port" && typeof value === "number") placeholders.dist_port = value;
    else if (key === "gpu_ids" && typeof value === "string") placeholders.gpu_ids = value;
    else if (key === "memory_gb" && typeof value === "string") placeholders.memory_gb = value;
    else if (key === "vram_gb" && typeof value === "string") placeholders.vram_gb = value;
    else if (key === "memory_fraction" && typeof value === "string")
      placeholders.memory_fraction = value;
  }
  if (intent.nnodes > 1 && headAddr) placeholders.head_addr = headAddr;
  return placeholders;
}

/** Whether the job frame of this step names the fabric (multi-node steps only). */
export function stepJobFabricId(intent: StepIntent): string | null {
  return intent.nnodes > 1 && intent.fabricId ? intent.fabricId : null;
}
