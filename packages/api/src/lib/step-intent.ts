/**
 * What an instance step carries (`InstanceStep.intent`, hashed into `intentHash`) and the
 * placeholder values its `runtime.job` frame sends. Shared by the server's dispatch
 * (`apps/server/src/runtimes/steps.ts` `jobFrame`) and the step views
 * (`runtime-views.ts`), so the command a person is shown is rendered from exactly the values
 * the node receives.
 */
import { z } from "zod";

/**
 * The GPU indices of a claim's recorded GPUs (`resources.gpus`, keys `vendor:index`, as placement
 * picked them) as a job sends them (`0,3`: a rank's `placeholders.gpu_ids`, a reservation's
 * `gpuIds`). Null when it recorded none, or a key that is not `vendor:index`.
 */
export function claimGpuIds(resources: unknown): string | null {
  if (!resources || typeof resources !== "object") return null;
  const gpus = Reflect.get(resources, "gpus");
  if (!Array.isArray(gpus)) return null;
  const ids = gpus
    .map((key) => (typeof key === "string" ? /^[a-z]+:([0-9]{1,3})$/.exec(key)?.[1] : undefined))
    .filter((id): id is string => id !== undefined);
  return ids.length > 0 && ids.length === gpus.length ? ids.join(",") : null;
}

/** One reservation's node as a step carries it (the job frame's `reservations` entry). */
export const stepReservationSchema = z
  .object({
    /** Position in `launch.reservations`. */
    index: z.number().int().min(0).max(7),
    nodeId: z.string(),
    /** The node's slug when the run was prepared. */
    node: z.string(),
    /**
     * The worker GPUs placement accounted to the reservation (`claimGpuIds` of its resources),
     * exported to the job's commands as `WSMP_RESERVATION_<index>_GPUS`. Absent: none recorded
     * (or a step stored before steps carried them).
     */
    gpuIds: z.string().optional(),
  })
  .strict();

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
    /**
     * Single-node only: the nodes the run's reservations (`launch.reservations`) were placed
     * on (with the worker GPUs each was given), frozen with the run, so a stop of an earlier
     * launch names the workers that launch got. Sent in the job (`reservations`), exported to
     * its commands as `WSMP_RESERVATION_*`.
     * Absent: none (or a step stored before steps carried them).
     */
    reservations: z.array(stepReservationSchema).min(1).max(8).optional(),
  })
  .strict();
export type StepIntent = z.infer<typeof stepIntentSchema>;
export type StepReservation = z.infer<typeof stepReservationSchema>;

/** The job's `reservations`: only for a single-node step that has them. */
export function stepJobReservations(intent: StepIntent): StepReservation[] | null {
  return intent.nnodes === 1 && intent.reservations && intent.reservations.length > 0
    ? intent.reservations
    : null;
}

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
