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
 * `HEALTH_SEQUENCE_BASE` and up. The generation is the instance's run (`instance-run.ts`), and
 * order inside a run is the phase slot (`slotOf`), not the raw sequence.
 *
 * Stops and status probes (the leading stop included) name what physically runs on the rank:
 * the intent of its latest launch (`Physical`), which may be of an earlier launch version, port
 * or unit than the run's own. The node matches its record by that identity and uses the
 * record's own stop command, so a restart onto a new version still stops the old process.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "@ws-model-proxy/api/lib/canonical-json";
import { GENERATION_STRIDE } from "@ws-model-proxy/api/lib/instance-run";
import {
  RUNTIME_TIMEOUTS_SEC,
  type RuntimeCommands,
  type RuntimeLaunch,
} from "@ws-model-proxy/api/lib/runtime-spec";
import {
  claimGpuIds,
  type StepIntent,
  type StepReservation,
  stepIntentSchema,
  stepJobFabricId,
  stepJobPlaceholders,
  stepJobReservations,
} from "@ws-model-proxy/api/lib/step-intent";
import { type JobPlaceholders, type RuntimeJobFrame, runtimeUnitName } from "../relay/frames.js";

export const HEALTH_SEQUENCE_BASE = 1_000_000;
/** Status probes of ranks marked stopped (held-unknown): unbounded, like health probes. */
export const STATUS_SEQUENCE_BASE = 2_000_000;
export { GENERATION_STRIDE };
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
export { type StepIntent, type StepReservation, stepIntentSchema };

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
  /**
   * A stop or status probe of a recorded launch (`Physical`): the head address it was
   * dispatched with (`InstanceStep.headAddr`). Absent: resolved at dispatch.
   */
  headAddr?: string | null;
  /**
   * A leading STOP with nothing left to stop (every earlier launch of the rank is proven
   * stopped): created SUCCEEDED, never sent. Absent: PENDING.
   */
  state?: "SUCCEEDED";
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
  const gpuIds = claimGpuIds(resources);
  if (gpuIds) out.gpu_ids = gpuIds;
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
  /** The run's reservation nodes (single-node instances only). */
  reservations?: readonly StepReservation[];
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
    ...(input.nnodes === 1 && input.reservations && input.reservations.length > 0
      ? { reservations: [...input.reservations].sort((a, b) => a.index - b.index) }
      : {}),
  };
}

/**
 * What runs on a rank: the stored intent of its latest launch, the launch (spec) of that
 * intent's version (the stop's timeout and interactivity come from it), and the head address the
 * launch was dispatched with (multi-node; null when not recorded).
 */
export type Physical = { intent: StepIntent; launch: RuntimeLaunch; headAddr: string | null };

function physicalIntent(input: Parameters<typeof intentFor>[0], physical: Physical): StepIntent {
  const commands = commandsFor(physical.launch, input.rank.rank);
  return {
    ...physical.intent,
    operationId: input.operationId,
    timeoutMs: timeoutFor(input.phase, physical.launch, commands),
    interactive: interactiveFor(input.phase, commands),
  };
}

function step(
  input: Parameters<typeof intentFor>[0],
  sequence: number,
  generation: number,
  physical?: Physical,
): NewStep {
  const intent = physical ? physicalIntent(input, physical) : intentFor(input);
  return {
    rank: input.rank.rank,
    phase: input.phase,
    sequence,
    generation,
    intent,
    intentHash: intentHash(intent),
    ...(physical?.headAddr ? { headAddr: physical.headAddr } : {}),
  };
}

/**
 * Every step of start generation `generation` (≥ 1). `physical`: per rank, what runs there now
 * (its leading stop names it). `ended`: ranks whose every earlier launch is proven stopped: their
 * leading stop is satisfied already (SUCCEEDED, never sent). A node may keep a stopped record of
 * an earlier version, which refuses a stop naming another one, while it takes the new version's
 * start (nothing of the old one runs).
 */
export function generationSteps(input: {
  instance: InstanceInput;
  ranks: readonly RankInput[];
  launch: RuntimeLaunch;
  generation: number;
  operationId: string | null;
  physical?: ReadonlyMap<number, Physical>;
  /** The run's reservation nodes (single-node instances only). */
  reservations?: readonly StepReservation[];
  ended?: ReadonlySet<number>;
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
    ...(input.reservations ? { reservations: input.reservations } : {}),
  };
  for (const rank of ranks) {
    const commands = commandsFor(input.launch, rank.rank);
    if (input.generation > 1) {
      const leading = step(
        { ...common, rank, phase: "STOP" },
        base + ORDER.STOP,
        input.generation,
        input.physical?.get(rank.rank),
      );
      steps.push(input.ended?.has(rank.rank) ? { ...leading, state: "SUCCEEDED" } : leading);
    }
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
  /** What runs on the rank (absent: the instance's own launch). */
  physical?: Physical;
  /** The run's reservation nodes, without `physical` (with it, the launch's own). */
  reservations?: readonly StepReservation[];
}): NewStep {
  return step(
    {
      instance: input.instance,
      rank: input.rank,
      nnodes: input.nnodes,
      phase: input.phase ?? "STOP",
      launch: input.launch,
      operationId: input.operationId,
      ...(input.reservations ? { reservations: input.reservations } : {}),
    },
    input.phase === "STATUS"
      ? STATUS_SEQUENCE_BASE + input.attempt
      : input.generation * GENERATION_STRIDE + STOP_ORDER_BASE + Math.min(input.attempt, 49),
    input.generation,
    input.physical,
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
  reservations?: readonly StepReservation[];
}): NewStep {
  return step(
    {
      instance: input.instance,
      rank: input.head,
      nnodes: input.nnodes,
      phase: "HEALTH",
      launch: input.launch,
      operationId: null,
      ...(input.reservations ? { reservations: input.reservations } : {}),
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
  /**
   * The node's CLI reads `reservations` (hello `features.jobReservations`). A released CLI
   * refuses a job with unknown fields: without it they are left out (a start that needs them
   * is refused before it is sent, `cli_upgrade_required`).
   */
  jobReservations?: boolean;
}): RuntimeJobFrame {
  const { intent } = input;
  const reservations = input.jobReservations ? stepJobReservations(intent) : null;
  // The same values the step views render the shown command from (`step-intent.ts`).
  const placeholders: JobPlaceholders = stepJobPlaceholders(intent, input.headAddr);
  const fabricId = stepJobFabricId(intent);
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
    ...(fabricId ? { fabricId } : {}),
    timeoutMs: intent.timeoutMs,
    ownerEpoch: input.ownerEpoch,
    intentHash: input.intentHash,
    ...(input.operator ? { operator: input.operator } : {}),
    ...(reservations ? { reservations } : {}),
  };
}
