/**
 * The steps of one start generation and the `runtime.job` frames built from them (spec
 * §3.4–3.6). Pure: the lifecycle engine (`lifecycle.ts`) writes and dispatches them.
 *
 * Order inside a generation (`sequence = generation * 100 + order`, every rank the same
 * order so ranks run a phase in parallel; a step waits until every lower-sequence start-phase
 * step of its generation succeeded):
 *   0  STOP        restart generations only: a status-first stop of whatever the rank ran
 *   10 PREPARE     ranks whose commands have `prepare`
 *   20 START       every rank
 *   30 AFTER_JOIN  ranks whose commands have `afterJoin` (after every rank started)
 *   40 READINESS   rank 0 (the head) only
 * Gang stops add STOP steps with `sequence = generation * 100 + 50 + n`; health probes use
 * `HEALTH_SEQUENCE_BASE` and up.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "@ws-model-proxy/api/lib/canonical-json";
import {
  RUNTIME_TIMEOUTS_SEC,
  type RuntimeCommands,
  type RuntimeLaunch,
} from "@ws-model-proxy/api/lib/runtime-spec";
import { z } from "zod";
import { type JobPlaceholders, type RuntimeJobFrame, runtimeUnitName } from "../relay/frames.js";

export const HEALTH_SEQUENCE_BASE = 1_000_000;
/** Status probes of forgotten (held-unknown) ranks: unbounded, like health probes. */
export const STATUS_SEQUENCE_BASE = 2_000_000;
export const GENERATION_STRIDE = 100;
export const STOP_ORDER_BASE = 50;
/** Health probes and status checks of the CLI are short. */
export const HEALTH_TIMEOUT_MS = 60_000;
/** Readiness without a spec timeout. */
export const READINESS_DEFAULT_TIMEOUT_MS = 600_000;

export type StepPhase =
  | "PREPARE"
  | "START"
  | "AFTER_JOIN"
  | "READINESS"
  | "HEALTH"
  | "STOP"
  | "STATUS";
export const START_PHASES = ["PREPARE", "START", "AFTER_JOIN", "READINESS"] as const;

const ORDER: Record<"STOP" | "PREPARE" | "START" | "AFTER_JOIN" | "READINESS", number> = {
  STOP: 0,
  PREPARE: 10,
  START: 20,
  AFTER_JOIN: 30,
  READINESS: 40,
};

const WIRE_PHASE = {
  PREPARE: "prepare",
  START: "start",
  AFTER_JOIN: "after_join",
  READINESS: "readiness",
  HEALTH: "health",
  STOP: "stop",
  STATUS: "status",
} as const satisfies Record<StepPhase, RuntimeJobFrame["phase"]>;

/** What a step carries (stored as `InstanceStep.intent`, hashed into `intentHash`). */
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

export function intentHash(intent: StepIntent): string {
  return createHash("sha256").update(canonicalJson(intent), "utf8").digest("hex");
}

export type RankInput = {
  rank: number;
  port: number;
  distPort: number | null;
  resources: unknown;
};

export type InstanceInput = {
  id: string;
  handle: string;
  runtimeId: string;
  launchVersionId: string;
  launchHash: string;
  fabricId: string | null;
};

export type NewStep = {
  rank: number;
  phase: StepPhase;
  sequence: number;
  generation: number;
  intent: StepIntent;
  intentHash: string;
};

function commandsFor(launch: RuntimeLaunch, rank: number): RuntimeCommands {
  const commands = launch.commands[rank] ?? launch.commands[0];
  if (!commands) throw new Error("A launch has at least one commands entry.");
  return commands;
}

function timeoutFor(phase: StepPhase, launch: RuntimeLaunch, commands: RuntimeCommands): number {
  const seconds = commands.timeoutsSec;
  switch (phase) {
    case "PREPARE":
      return (seconds?.prepare ?? RUNTIME_TIMEOUTS_SEC.prepare.default) * 1000;
    case "START":
      return (seconds?.start ?? RUNTIME_TIMEOUTS_SEC.start.default) * 1000;
    case "AFTER_JOIN":
      return (seconds?.afterJoin ?? RUNTIME_TIMEOUTS_SEC.afterJoin.default) * 1000;
    case "STOP":
      return (seconds?.stop ?? RUNTIME_TIMEOUTS_SEC.stop.default) * 1000;
    case "STATUS":
      return (seconds?.status ?? RUNTIME_TIMEOUTS_SEC.status.default) * 1000;
    case "READINESS":
      return launch.readiness?.timeoutMs ?? READINESS_DEFAULT_TIMEOUT_MS;
    case "HEALTH":
      return HEALTH_TIMEOUT_MS;
  }
}

function interactiveFor(phase: StepPhase, commands: RuntimeCommands): boolean {
  const flags = commands.interactive;
  if (!flags) return false;
  if (phase === "PREPARE") return flags.prepare === true;
  if (phase === "START") return flags.start === true;
  if (phase === "AFTER_JOIN") return flags.afterJoin === true;
  if (phase === "STOP") return flags.stop === true;
  return false;
}

/** Canonical decimal as the node substitutes it (§4.6): at most 6 places, no exponent. */
export function canonicalDecimal(value: number): string | null {
  if (!Number.isFinite(value) || value < 0 || value >= 1e15) return null;
  const text = value.toFixed(6).replace(/\.?0+$/, "");
  return /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(text) ? text : null;
}

/**
 * Placeholders from the rank's claim: `gpu_ids` from the GPUs placement recorded
 * (`resources.gpus`, keys `vendor:index`), `memory_gb` / `vram_gb` from the resource.
 */
export function rankPlaceholders(resources: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!resources || typeof resources !== "object") return out;
  const gpus = Reflect.get(resources, "gpus");
  if (Array.isArray(gpus)) {
    const ids = gpus
      .map((key) => (typeof key === "string" ? /^[a-z]+:([0-9]{1,3})$/.exec(key)?.[1] : undefined))
      .filter((id): id is string => id !== undefined);
    if (ids.length > 0 && ids.length === gpus.length) out.gpu_ids = ids.join(",");
  }
  const kind = Reflect.get(resources, "kind");
  const number = (key: string) => {
    const value = Reflect.get(resources, key);
    return typeof value === "number" ? canonicalDecimal(value) : null;
  };
  if (kind === "unified") {
    const memory = number("memoryGb");
    if (memory) out.memory_gb = memory;
  } else if (kind === "cpu") {
    const memory = number("ramGb");
    if (memory) out.memory_gb = memory;
  } else if (kind === "discrete") {
    const vram = number("vramGb");
    if (vram) out.vram_gb = vram;
    const memory = number("ramGb");
    if (memory) out.memory_gb = memory;
  }
  return out;
}

function intentFor(input: {
  instance: InstanceInput;
  rank: RankInput;
  nnodes: number;
  phase: StepPhase;
  launch: RuntimeLaunch;
  operationId: string | null;
}): StepIntent {
  const commands = commandsFor(input.launch, input.rank.rank);
  const placeholders: Record<string, string | number> = {
    port: input.rank.port,
    ...rankPlaceholders(input.rank.resources),
  };
  if (input.nnodes > 1 && input.rank.distPort !== null)
    placeholders.dist_port = input.rank.distPort;
  return {
    operationId: input.operationId,
    runtimeId: input.instance.runtimeId,
    launchVersionId: input.instance.launchVersionId,
    launchHash: input.instance.launchHash,
    rank: input.rank.rank,
    nnodes: input.nnodes,
    handle: input.instance.handle,
    unitName: runtimeUnitName(input.instance.handle, input.rank.rank),
    port: input.rank.port,
    distPort: input.rank.distPort,
    fabricId: input.nnodes > 1 ? input.instance.fabricId : null,
    placeholders,
    timeoutMs: timeoutFor(input.phase, input.launch, commands),
    interactive: interactiveFor(input.phase, commands),
  };
}

function step(
  input: Parameters<typeof intentFor>[0],
  sequence: number,
  generation: number,
): NewStep {
  const intent = intentFor(input);
  return {
    rank: input.rank.rank,
    phase: input.phase,
    sequence,
    generation,
    intent,
    intentHash: intentHash(intent),
  };
}

/** Every step of start generation `generation` (≥ 1). */
export function generationSteps(input: {
  instance: InstanceInput;
  ranks: readonly RankInput[];
  launch: RuntimeLaunch;
  generation: number;
  operationId: string | null;
}): NewStep[] {
  const ranks = [...input.ranks].sort((a, b) => a.rank - b.rank);
  const nnodes = ranks.length;
  const base = input.generation * GENERATION_STRIDE;
  const steps: NewStep[] = [];
  const common = {
    instance: input.instance,
    nnodes,
    launch: input.launch,
    operationId: input.operationId,
  };
  for (const rank of ranks) {
    const commands = commandsFor(input.launch, rank.rank);
    if (input.generation > 1)
      steps.push(step({ ...common, rank, phase: "STOP" }, base + ORDER.STOP, input.generation));
    if (commands.prepare)
      steps.push(
        step({ ...common, rank, phase: "PREPARE" }, base + ORDER.PREPARE, input.generation),
      );
    steps.push(step({ ...common, rank, phase: "START" }, base + ORDER.START, input.generation));
    if (commands.afterJoin)
      steps.push(
        step({ ...common, rank, phase: "AFTER_JOIN" }, base + ORDER.AFTER_JOIN, input.generation),
      );
  }
  const head = ranks[0];
  if (head)
    steps.push(
      step({ ...common, rank: head, phase: "READINESS" }, base + ORDER.READINESS, input.generation),
    );
  return steps;
}

/** One gang-stop step for a rank (attempt `n` of this generation's stops). */
export function stopStep(input: {
  instance: InstanceInput;
  rank: RankInput;
  nnodes: number;
  launch: RuntimeLaunch;
  generation: number;
  attempt: number;
  operationId: string | null;
  phase?: "STOP" | "STATUS";
}): NewStep {
  return step(
    {
      instance: input.instance,
      rank: input.rank,
      nnodes: input.nnodes,
      phase: input.phase ?? "STOP",
      launch: input.launch,
      operationId: input.operationId,
    },
    input.phase === "STATUS"
      ? STATUS_SEQUENCE_BASE + input.attempt
      : input.generation * GENERATION_STRIDE + STOP_ORDER_BASE + Math.min(input.attempt, 49),
    input.generation,
  );
}

/** A health probe on the head rank. */
export function healthStep(input: {
  instance: InstanceInput;
  head: RankInput;
  nnodes: number;
  launch: RuntimeLaunch;
  generation: number;
  sequence: number;
}): NewStep {
  return step(
    {
      instance: input.instance,
      rank: input.head,
      nnodes: input.nnodes,
      phase: "HEALTH",
      launch: input.launch,
      operationId: null,
    },
    Math.max(HEALTH_SEQUENCE_BASE, input.sequence),
    input.generation,
  );
}

/** The `runtime.job` frame for a claimed step. */
export function jobFrame(input: {
  stepId: string;
  instanceId: string;
  phase: StepPhase;
  generation: number;
  intent: StepIntent;
  intentHash: string;
  ownerEpoch: string;
  headAddr: string | null;
  operator?: RuntimeJobFrame["operator"];
}): RuntimeJobFrame {
  const { intent } = input;
  const placeholders: JobPlaceholders = { port: intent.port };
  for (const [key, value] of Object.entries(intent.placeholders)) {
    if (key === "dist_port" && typeof value === "number") placeholders.dist_port = value;
    else if (key === "gpu_ids" && typeof value === "string") placeholders.gpu_ids = value;
    else if (key === "memory_gb" && typeof value === "string") placeholders.memory_gb = value;
    else if (key === "vram_gb" && typeof value === "string") placeholders.vram_gb = value;
    else if (key === "memory_fraction" && typeof value === "string")
      placeholders.memory_fraction = value;
  }
  if (intent.nnodes > 1 && input.headAddr) placeholders.head_addr = input.headAddr;
  return {
    type: "runtime.job",
    stepId: input.stepId,
    instanceId: input.instanceId,
    runtimeId: intent.runtimeId,
    launchVersionId: intent.launchVersionId,
    launchHash: intent.launchHash,
    generation: input.generation,
    rank: intent.rank,
    nnodes: intent.nnodes,
    phase: WIRE_PHASE[input.phase],
    handle: intent.handle,
    unitName: intent.unitName,
    placeholders,
    ...(intent.nnodes > 1 && intent.fabricId ? { fabricId: intent.fabricId } : {}),
    timeoutMs: intent.timeoutMs,
    ownerEpoch: input.ownerEpoch,
    intentHash: input.intentHash,
    ...(input.operator ? { operator: input.operator } : {}),
  };
}
