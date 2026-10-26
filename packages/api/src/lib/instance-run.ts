/**
 * An instance's run: which step generation owns its claims now (`RuntimeInstance.runGeneration`).
 *
 * Every restart begins a new run in the transaction that commits it (`beginRun`: the automatic
 * restart and runtime_start / profile apply through `retakeInstanceClaims`, and a definition
 * update's restart), and a new instance starts at run 1. From that commit on, a step of an
 * earlier run is never dispatched and its answers change nothing about the instance: they are
 * not `owned`. Inside the current run, an observation is `fresh` only when nothing of the run
 * was launched after the observed point (the phase order `slotOf`, independent of the
 * generation number). Ownership and freshness are separate checks: a stop proof needs both.
 *
 * Callers hold the instance's owner fence and its capacity fence (`runGeneration` is a policy
 * column of the graph-write fence). Rows written before runs existed have `runGeneration` 0:
 * `resolveRun` bootstraps them from their steps on first touch, and the SQL trigger
 * `instance_run_order` keeps every new step at the instance's (positive) run.
 */
import type { Prisma } from "@ws-model-proxy/db";

type Db = Prisma.TransactionClient;

/** Generation stride of step sequences (`apps/server/src/runtimes/steps.ts`). */
export const GENERATION_STRIDE = 100;
/** The phases that start a run, in order. */
export const RUN_START_PHASES = ["PREPARE", "START", "AFTER_JOIN", "READINESS"] as const;

const START_PHASE_SET: ReadonlySet<string> = new Set(RUN_START_PHASES);

export function isRunStartPhase(phase: string): boolean {
  return START_PHASE_SET.has(phase);
}

/** What `slotOf` reads of a step. */
export type RunStep = { phase: string; sequence: number; generation: number };

/**
 * A step's place inside its run, independent of the generation number: the run's leading STOP
 * (proof the previous run ended) 0 < PREPARE 10 < START 20 < AFTER_JOIN 30 < READINESS 40 <
 * a gang STOP 50 < HEALTH 60 < STATUS 70.
 */
export function slotOf(step: RunStep): number {
  switch (step.phase) {
    case "STOP":
      return step.sequence === step.generation * GENERATION_STRIDE ? 0 : 50;
    case "PREPARE":
      return 10;
    case "START":
      return 20;
    case "AFTER_JOIN":
      return 30;
    case "READINESS":
      return 40;
    case "HEALTH":
      return 60;
    default:
      return 70;
  }
}

/** The leading STOP of its run (generation > 1): a status-first stop of what ran before. */
export function isLeadingStop(step: RunStep): boolean {
  return step.phase === "STOP" && slotOf(step) === 0;
}

/** A step belongs to the instance's run `run` (ownership). */
export function owned(step: { generation: number }, run: number): boolean {
  return step.generation === run;
}

type RunRow = { runGeneration: number; phase: string; operationId: string | null };

/**
 * Phases a committed restart can be in before its start steps exist: STARTING (prepareStarts
 * has not reached it) and UNAVAILABLE (a node of it went offline first; recovery returns it to
 * STARTING). A row that reached either from a prepared run has a start step naming its
 * operation, so the operation test below keeps it at its latest generation.
 */
const UNPREPARED_PHASES: ReadonlySet<string> = new Set(["STARTING", "UNAVAILABLE"]);

/**
 * The run a legacy row (`runGeneration` 0) is on: its latest step generation, plus one when a
 * restart was committed and not prepared yet (STARTING or UNAVAILABLE under an operation no
 * start step names, the test `prepareStarts` uses), and at least 1.
 */
async function legacyRun(db: Db, instanceId: string, row: RunRow): Promise<number> {
  const latest =
    (
      await db.instanceStep.aggregate({
        where: { instanceId, phase: { not: "HEALTH" } },
        _max: { generation: true },
      })
    )._max.generation ?? 0;
  const unprepared =
    UNPREPARED_PHASES.has(row.phase) &&
    row.operationId !== null &&
    (await db.instanceStep.count({
      where: {
        instanceId,
        phase: { in: [...RUN_START_PHASES] },
        intent: { path: ["operationId"], equals: row.operationId },
      },
    })) === 0;
  return Math.max(1, latest + (unprepared ? 1 : 0));
}

async function runRow(db: Db, instanceId: string): Promise<RunRow | null> {
  return db.runtimeInstance.findUnique({
    where: { id: instanceId },
    select: { runGeneration: true, phase: true, operationId: true },
  });
}

/**
 * The instance's current run (≥ 1). A legacy row is bootstrapped and the value persisted, so
 * every later decision reads the same run whether or not its start was prepared. Callers hold
 * the owner and instance capacity fences. 0 when the instance does not exist.
 */
export async function resolveRun(db: Db, instanceId: string): Promise<number> {
  const row = await runRow(db, instanceId);
  if (!row) return 0;
  if (row.runGeneration > 0) return row.runGeneration;
  const run = await legacyRun(db, instanceId, row);
  await db.runtimeInstance.updateMany({
    where: { id: instanceId, runGeneration: 0 },
    data: { runGeneration: run },
  });
  return run;
}

/** `resolveRun` without the write, for unfenced read-only callers. */
export async function peekRun(db: Db, instanceId: string): Promise<number> {
  const row = await runRow(db, instanceId);
  if (!row) return 0;
  return row.runGeneration > 0 ? row.runGeneration : legacyRun(db, instanceId, row);
}

/**
 * A restart was committed: the instance's next run begins now (the only increment). Returns it.
 * Callers hold the owner and instance capacity fences, in the transaction that commits the
 * restart.
 */
export async function beginRun(db: Db, instanceId: string): Promise<number> {
  const run = (await resolveRun(db, instanceId)) + 1;
  await db.runtimeInstance.update({ where: { id: instanceId }, data: { runGeneration: run } });
  return run;
}

/**
 * Nothing of run `run` was launched on this rank after `step` was observed: no start-phase step
 * of the run (this rank) that was dispatched (attempts > 0) has a later slot. A gang STOP,
 * HEALTH or STATUS of the run is always after its launches; its leading STOP is not once its
 * START was dispatched.
 */
export async function fresh(
  db: Db,
  step: RunStep & { instanceId: string; rank: number },
  run: number,
): Promise<boolean> {
  const slot = slotOf(step);
  if (slot >= 50) return true;
  const launched = await db.instanceStep.findMany({
    where: {
      instanceId: step.instanceId,
      rank: step.rank,
      generation: run,
      phase: { in: [...RUN_START_PHASES] },
      attempts: { gt: 0 },
    },
    select: { phase: true, sequence: true, generation: true },
  });
  return launched.every((launch) => slotOf(launch) <= slot);
}

/**
 * Pre-admission codes prove the rank never ran this step, so the server may auto-release its
 * claim (§3.5). Other codes are stored as `InstanceStep.errorCode`. (The relay protocol's list,
 * `apps/server/src/relay/frames.ts` re-exports it.)
 */
export const RUNTIME_JOB_PRE_ADMISSION_ERRORS = [
  "execution_mechanism_unavailable",
  "bad_job",
  "interactive_unsupported",
  "operator_terminals_disabled",
  "trust_relay",
  "definition_missing",
  "definition_frozen",
  "local_config_unavailable",
  "session_disconnected",
] as const;

/**
 * The codes a node answers a runtime job it admitted with (`RUNTIME_JOB_ERRORS` in the relay
 * frames, after the pre-admission codes). `job_deadline` is also the server's own close of a
 * step past its deadline.
 */
export const RUNTIME_JOB_ADMITTED_ERRORS = [
  "instance_unknown",
  "owned_launch_unconfirmed",
  "launch_unconfirmed",
  "command_failed",
  "readiness_failed",
  "health_failed",
  "job_deadline",
  /**
   * A `process` start handed its server off out of the node's units (its start unit has no task
   * left while the port answers): it needs `management: "service"` with stop and status.
   */
  "process_detached",
] as const;

/** Rank claims that still hold their node (a stop not proven yet keeps HELD_UNKNOWN). */
export const LIVE_CLAIMS = ["HELD", "HELD_UNKNOWN"] as const;

const PRE_ADMISSION_SET: ReadonlySet<string> = new Set(RUNTIME_JOB_PRE_ADMISSION_ERRORS);

/**
 * What a step's answer proves about whether it ran, as every reader decides it (`neverRan` in
 * `claim-release.ts`, `physicalLaunch`, `physicalLaunchIntents`): a pre-admission code
 * (`RUNTIME_JOB_PRE_ADMISSION_ERRORS`) proves the attempt it answers never ran, and nothing
 * about an earlier dispatch of the same step that may have reached the node with no answer (its
 * session lost, its lease expired) before it was sent again. That one is recorded on the step
 * (`InstanceStep.mayHaveRun`, set when such an attempt is queued or sent again, never cleared:
 * CHECKed and trigger-fenced in SQL), so a later refusal never erases it.
 *
 * The Prisma filter of steps whose answer does not prove they never ran (an `OR`: callers put it
 * where no other `OR` is).
 */
export function notRefusedBeforeAdmissionWhere(): Prisma.InstanceStepWhereInput {
  return {
    OR: [
      { mayHaveRun: true },
      { errorCode: null },
      { errorCode: { notIn: [...RUNTIME_JOB_PRE_ADMISSION_ERRORS] } },
    ],
  };
}

/**
 * The step's answer proves it never ran: refused before admission, and no earlier dispatch of it
 * may have run (`notRefusedBeforeAdmissionWhere`). Rows read without the flag (older fixtures) count as not set.
 */
export function refusedBeforeAdmission(step: {
  errorCode: string | null;
  mayHaveRun?: boolean;
}): boolean {
  return step.mayHaveRun !== true && PRE_ADMISSION_SET.has(step.errorCode ?? "");
}

/**
 * `InstanceStep.mayHaveRun` for a step going back to PENDING (or sent again) with `attempts`
 * counted dispatches: set when one was counted (it may have reached the node, and no answer says
 * it did not), else left as it is (undefined writes nothing; the flag is never cleared).
 */
export function mayHaveRunAfterRequeue(attempts: number): true | undefined {
  return attempts > 0 ? true : undefined;
}

/**
 * What makes a step a physical launch (`physicalLaunch`, `physicalLaunchIntents`): a start-phase
 * step that was dispatched (attempts > 0), whose answer does not prove it never ran
 * (`notRefusedBeforeAdmissionWhere`), and that is not proven stopped (`launchesEnded`). Both
 * lookups read these, so they cannot drift apart.
 */
const PHYSICAL_LAUNCH = {
  phases: RUN_START_PHASES,
  /** Dispatched at least once. */
  minAttempts: 1,
} as const;

/**
 * The rank's start-phase steps after run `after` that could have started a process (physical
 * launches, `PHYSICAL_LAUNCH`). None after the rank's proven boundary: nothing it launched can
 * still run (`physicalLaunch` finds none; `neverRan` in `claim-release.ts`).
 */
export function launchedAfterWhere(
  instanceId: string,
  rank: number,
  after: number,
): Prisma.InstanceStepWhereInput {
  return {
    instanceId,
    rank,
    generation: { gt: after },
    phase: { in: [...PHYSICAL_LAUNCH.phases] },
    attempts: { gte: PHYSICAL_LAUNCH.minAttempts },
    ...notRefusedBeforeAdmissionWhere(),
  };
}

/**
 * The runs of a rank whose starts may still matter: those after its proven boundary
 * (`launchesEnded`), or none at all once every launch is proven ended. What `startsUnresolved`
 * reads, as the physical lookups do.
 */
async function liveRunsAfter(db: Db, instanceId: string, rank: number): Promise<number | null> {
  const row = await db.instanceRank.findUnique({
    where: { instanceId_rank: { instanceId, rank } },
    select: { claim: true, releasedUnprovenAt: true, stoppedThroughRun: true },
  });
  if (!row) return 0;
  const ended = launchesEnded(row);
  return ended === "all" ? null : ended.throughRun;
}

/**
 * The rank's start-phase steps after run `after` whose dispatch the node has not answered: sent
 * and not answered (RUNNING, or AWAITING_OPERATOR), or sent and requeued when their session was
 * lost (PENDING with an attempt: the node re-observes them on its return). `before`: only those
 * of runs before it.
 */
function unresolvedStartsWhere(
  instanceId: string,
  rank: number,
  after: number,
  before?: number,
): Prisma.InstanceStepWhereInput {
  return {
    instanceId,
    rank,
    generation: before === undefined ? { gt: after } : { gt: after, lt: before },
    phase: { in: [...RUN_START_PHASES] },
    OR: [
      { state: { in: ["RUNNING", "AWAITING_OPERATOR"] } },
      { state: "PENDING", attempts: { gt: 0 } },
    ],
  };
}

/**
 * Whether a dispatch of a start of the rank, after its proven boundary, is unanswered
 * (`unresolvedStartsWhere`): the server's own bookkeeping of when to send a stop. A leading stop
 * waits for them, and one is satisfied without the node only when there are none (the lifecycle's
 * `createGeneration`). What a node's stopped answer proves is the node's to say (`rankIdle`,
 * `proofHolds` in `claim-release.ts`).
 */
export async function startsUnresolved(
  db: Db,
  instanceId: string,
  rank: number,
  before?: number,
): Promise<boolean> {
  const after = await liveRunsAfter(db, instanceId, rank);
  if (after === null) return false;
  return (
    (await db.instanceStep.count({
      where: unresolvedStartsWhere(instanceId, rank, after, before),
    })) > 0
  );
}

/**
 * The stored intent of the latest step of this rank that could have started a process (a
 * physical launch, `PHYSICAL_LAUNCH`), with the head's fabric address that launch was dispatched
 * with (a multi-node launch; null otherwise, or for a launch dispatched before steps recorded
 * it). What a stop or status probe must name to reach the process that actually runs (its
 * launch version, port, unit, head), even once the head's node is gone. Null when nothing was
 * launched since the rank's last proven stop.
 */
export async function physicalLaunch(
  db: Db,
  instanceId: string,
  rank: number,
): Promise<{ intent: Prisma.JsonValue; headAddr: string | null } | null> {
  const row = await db.instanceRank.findUnique({
    where: { instanceId_rank: { instanceId, rank } },
    select: { claim: true, releasedUnprovenAt: true, stoppedThroughRun: true },
  });
  if (row && launchesEnded(row) === "all") return null;
  // One row, newest first (bounded however long the rank's history is).
  const latest = await db.instanceStep.findFirst({
    where: launchedAfterWhere(instanceId, rank, row?.stoppedThroughRun ?? 0),
    select: { intent: true, headAddr: true },
    orderBy: [{ generation: "desc" }, { sequence: "desc" }],
  });
  // Rows read without the select (older callers' fixtures) have no address.
  return latest ? { intent: latest.intent, headAddr: latest.headAddr ?? null } : null;
}

/**
 * Which of a rank's launches are proven stopped: all of them while its claim is RELEASED with
 * proof (a node's proof, steps that never ran, its node's deletion: a release without proof
 * records who made it), else those of runs up to `stoppedThroughRun` (written when a restart
 * retakes a claim released with proof, `retakeInstanceClaims`, and when a run's leading STOP
 * succeeds, `recordStoppedThrough`). A launch that may still run keeps
 * its version required on the node and is what the next run's leading STOP names.
 */
export function launchesEnded(rank: {
  claim: string;
  releasedUnprovenAt: Date | null;
  stoppedThroughRun: number;
}): "all" | { throughRun: number } {
  return rank.claim === "RELEASED" && rank.releasedUnprovenAt === null
    ? "all"
    : { throughRun: rank.stoppedThroughRun };
}

/**
 * Records that every launch of this rank in runs up to `throughRun` is proven stopped
 * (`stoppedThroughRun`, which only grows): a leading STOP of run `throughRun + 1` succeeded (the
 * node answered stopped after every earlier start of the rank answered), or was satisfied because
 * nothing launched since the last proven boundary. The claim stays (the new run uses it).
 * Callers hold the instance's fences.
 */
export async function recordStoppedThrough(
  db: Db,
  instanceId: string,
  rank: number,
  throughRun: number,
): Promise<void> {
  await db.instanceRank.updateMany({
    where: { instanceId, rank, stoppedThroughRun: { lt: throughRun } },
    data: { stoppedThroughRun: throughRun },
  });
}

/** One rank's physical launch (`physicalLaunchIntents`). */
export type RankPhysicalLaunch = {
  instanceId: string;
  rank: number;
  nodeId: string;
  intent: Prisma.JsonValue;
};

/**
 * `physicalLaunch` of every rank of `userId`'s instances on one of these nodes, in one query
 * whatever the number of ranks: the latest physical launch per (instance, rank), served by the
 * `(instanceId, rank, phase, sequence)` index. Whatever the claim: a rank released without proof
 * may still run its launch. Ranks with no launch that may still run (`launchesEnded`) are absent.
 * Only the owner's instances (`runtime_instance."userId"`).
 */
export async function physicalLaunchIntents(
  db: Db,
  input: { userId: string; nodeIds: readonly string[] },
): Promise<RankPhysicalLaunch[]> {
  if (input.nodeIds.length === 0) return [];
  const nodeIds = [...input.nodeIds];
  const phases = [...PHYSICAL_LAUNCH.phases];
  const preAdmission = [...RUNTIME_JOB_PRE_ADMISSION_ERRORS];
  // `notRefusedBeforeAdmissionWhere` and `launchesEnded` in SQL.
  return db.$queryRaw<RankPhysicalLaunch[]>`
    SELECT DISTINCT ON (s."instanceId", s.rank)
      s."instanceId" AS "instanceId", s.rank AS rank, r."nodeId" AS "nodeId", s.intent AS intent
    FROM instance_step s
    JOIN instance_rank r ON r."instanceId" = s."instanceId" AND r.rank = s.rank
    JOIN runtime_instance i ON i.id = s."instanceId"
    WHERE i."userId" = ${input.userId}
      AND r."nodeId" = ANY(${nodeIds}::text[])
      AND NOT (r.claim = 'RELEASED' AND r."releasedUnprovenAt" IS NULL)
      AND s.generation > r."stoppedThroughRun"
      AND s.phase::text = ANY(${phases}::text[])
      AND s.attempts >= ${PHYSICAL_LAUNCH.minAttempts}
      AND (s."mayHaveRun" OR s."errorCode" IS NULL
        OR NOT (s."errorCode" = ANY(${preAdmission}::text[])))
    ORDER BY s."instanceId", s.rank, s.generation DESC, s.sequence DESC`;
}
