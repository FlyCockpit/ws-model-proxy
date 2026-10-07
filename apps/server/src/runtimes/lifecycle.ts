/**
 * The runtime lifecycle engine (spec §3.4–3.7): turns recorded operations into steps, dispatches
 * `runtime.job`, applies `runtime.job.result`, gang-stops, releases claims, restarts within the
 * window budget, probes health and held-unknown ranks, and registers execution targets when an
 * instance becomes READY.
 *
 * Every write runs under the owner fence (instance, rank and step rows are fenced graph tables)
 * and the instance's capacity fence. One tick at a time per process; conditional updates
 * (`updateMany` on the expected state) arbitrate between replicas and racing results.
 *
 * Interactive steps (spec §3.6, §4.7) run in an operator terminal a person answers: each
 * dispatch mints a fresh terminal id; the node reports `awaiting_operator` (the step waits for
 * its person, no deadline), `operator_running` (the person pressed Enter: the deadline starts)
 * and `operator_closed` (the terminal ended without success: the step waits, reopenable). One
 * interactive start step at a time per instance run, in recipe order; at most
 * {@link OPERATOR_TERMINALS_PER_NODE} live per node (stops exempt). A person's run is never cut
 * off: stops of the instance on that node wait behind it.
 *
 * A banned or deleting owner's steps that wait for a person are cancelled, and a rank whose
 * stop nobody can answer becomes HELD_UNKNOWN until a status probe proves the stop (§3.5).
 * Their non-interactive stops and status probes still go out; starts never do.
 *
 * Always-on runtimes in a node's inventory (node-origin ones included) are applied by
 * `./always-on.ts`; the engine facts of managed instances are recorded here.
 */
import { randomBytes } from "node:crypto";
import { sameStoredInstanceFacts, storedInstanceFacts } from "@ws-model-proxy/api/lib/engine-facts";
import { graphWrite, instanceCapacityFences } from "@ws-model-proxy/api/lib/graph-write";
import { type RuntimeLaunch, runtimeLaunchSchema } from "@ws-model-proxy/api/lib/runtime-spec";
import { RUNTIME_ADVANCED } from "@ws-model-proxy/config/runtime-defaults";
import prisma, { type Prisma } from "@ws-model-proxy/db";
import { userCredentialAccessBlocked } from "@ws-model-proxy/db/user-deletion-access";
import {
  type InstanceRecord,
  type NodeToServerControlFrame,
  type NodeTrustWire,
  RUNTIME_JOB_PRE_ADMISSION_ERRORS,
  type ServerToNodeControlFrame,
  STOP_PROOF_FAILURES,
} from "../relay/frames.js";
import { nodeOwnerMatches } from "../relay/node-owner.js";
import type {
  NodeFrameHandlers,
  NodeSessionRef,
  RuntimeInventorySnapshot,
  SendGuard,
} from "../relay/session-manager.js";
import { applyAlwaysOnInventory, instanceStoredFacts } from "./always-on.js";
import {
  GENERATION_STRIDE,
  generationSteps,
  HEALTH_SEQUENCE_BASE,
  healthStep,
  type InstanceInput,
  jobFrame,
  type NewStep,
  type RankInput,
  START_PHASES,
  STATUS_SEQUENCE_BASE,
  STOP_ORDER_BASE,
  type StepIntent,
  type StepPhase,
  stepIntentSchema,
  stopStep,
} from "./steps.js";

type Tx = Prisma.TransactionClient;
type JobResult = Extract<NodeToServerControlFrame, { type: "runtime.job.result" }>;

const TICK_MS = 1_000;
const BATCH = 64;
const LIVE_STEP_STATES = ["PENDING", "RUNNING", "AWAITING_OPERATOR"] as const;
const LIVE_PHASES = ["STARTING", "READY", "UNHEALTHY", "UNAVAILABLE"] as const;
const STOP_ATTEMPTS = 3;
/** A STOPPING rank whose node has been offline this long needs a person (Mark as stopped). */
export const MARK_STOPPED_AFTER_OFFLINE_MS = 10 * 60_000;
/** Held-unknown ranks are probed this often while their node is online. */
export const HELD_UNKNOWN_PROBE_MS = 5 * 60_000;
/** Completed health probes are kept this long. */
const HEALTH_HISTORY_MS = 60 * 60_000;
const DEFINITION_RETRY_MS = 5_000;
const RESTART_BACKOFF_BASE_MS = 10_000;
const RESTART_BACKOFF_MAX_MS = 5 * 60_000;
const RETAKE_RETRY_MS = 30_000;
/** Live operator terminals of non-stop steps per node; stops are exempt (never starved). */
export const OPERATOR_TERMINALS_PER_NODE = 4;
/**
 * An interactive job whose confirm screen did not come up within the node's budget for it
 * (status-first check included) plus this grace is sent again with a fresh terminal.
 */
const OPERATOR_SPAWN_GRACE_MS = 60_000;
const OPERATOR_SPAWN_BUDGET_MAX_MS = 15 * 60_000;
/** Why a PENDING interactive step is held before its claim (`operatorHold`, CHECKed). */
export const OPERATOR_HOLD = {
  capabilityMissing: "operator_capability_missing",
  sessionFull: "operator_session_full",
  nodeFull: "operator_node_full",
} as const;
const OPERATOR_HOLD_CODES: ReadonlySet<string> = new Set(Object.values(OPERATOR_HOLD));
/** A person gave up on an interactive step (`runtimes.steps.cancel`). */
export const OPERATOR_CANCELLED = "operator_cancelled";
/**
 * The owner is banned or deleting (`userCredentialAccessBlocked`): nobody may answer their
 * interactive steps, so the ones waiting for a person are cancelled with this code (and a
 * STARTING instance gang-stops with it as its reason).
 */
export const OWNER_INACTIVE = "owner_inactive";
/** `InstanceRank.markedStoppedBy` of a claim the engine marked stopped for an inactive owner (no person). */
export const MARKED_STOPPED_OWNER_INACTIVE = "system:owner_inactive";

/** A banned (ban active now) or deletion-pending owner, as `userCredentialAccessBlocked`. */
function inactiveOwner(now: Date): Prisma.UserWhereInput {
  return {
    OR: [
      { deletionRequestedAt: { not: null } },
      { banned: true, OR: [{ banExpires: null }, { banExpires: { gte: now } }] },
    ],
  };
}

/**
 * The complement of {@link inactiveOwner}, spelled out: `NOT` over the nullable `banned` would
 * drop never-banned owners (`banned` NULL) in SQL's three-valued logic.
 */
function activeOwner(now: Date): Prisma.UserWhereInput {
  return {
    deletionRequestedAt: null,
    OR: [{ banned: null }, { banned: false }, { banExpires: { lt: now } }],
  };
}

/** Codes that prove a stop cannot be proven by the node: a person decides (Mark as stopped). */
const UNPROVABLE_STOP = new Set([
  // A person gave up on an interactive stop: they decide (Mark as stopped), nothing is retried.
  OPERATOR_CANCELLED,
  "definition_missing",
  "definition_frozen",
  "instance_unknown",
  "owned_launch_unconfirmed",
  "launch_unconfirmed",
]);
const PRE_ADMISSION: ReadonlySet<string> = new Set(RUNTIME_JOB_PRE_ADMISSION_ERRORS);

export type LifecycleRelay = {
  sendToNode(nodeId: string, frame: ServerToNodeControlFrame, guard?: SendGuard): boolean;
  nodeSession(nodeId: string): {
    /** The node's owner (the live session's user). */
    userId: string;
    connectionGeneration: number;
    trust: NodeTrustWire;
    /** The node can hold operator terminals (feature and terminal key). */
    operatorTerminals?: boolean;
  } | null;
  /** Nodes with a live session here (dispatch looks at their steps only). */
  onlineNodeIds?(): string[];
  /** The node's session can track one more operator terminal (absent: always). */
  operatorRoom?(nodeId: string): boolean;
  /**
   * Close a step's operator terminal on whichever session holds it. `keepRunning` leaves a
   * person's run alone (answer `running`).
   */
  closeOperatorStep?(
    stepId: string,
    options?: { keepRunning?: boolean; actor?: "USER" | "SYSTEM" },
  ): "closed" | "running" | "absent";
  /** Close an operator terminal no step owns any more (a stale dispatch's), by its id. */
  closeOperatorTerminal?(nodeId: string, terminalId: string): void;
};

/** `runtimes.steps.reopen` / `cancel` refusals (the procedure maps them). */
export class OperatorStepError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "not_interactive"
      | "not_waiting"
      | "running"
      | "superseded"
      | "trust_relay",
  ) {
    super(`The step cannot be changed (${code}).`);
    this.name = "OperatorStepError";
  }
}

type StepRow = Prisma.InstanceStepGetPayload<true>;

/** Columns a step without a live operator dispatch carries (PENDING has none, CHECKed). */
const NO_OPERATOR = {
  operatorTerminalId: null,
  operatorSince: null,
  operatorAcceptedAt: null,
  operatorLastExit: null,
} as const;

function interactiveIntent(intent: Prisma.JsonValue): boolean {
  const parsed = stepIntentSchema.safeParse(intent);
  return parsed.success && parsed.data.interactive;
}

/**
 * The attempts of an interactive step whose live dispatch the server ends (stop, cancel,
 * reissue). The dispatch gives its attempt back only while its confirm screen never came up:
 * nobody can attach before `awaiting_operator`, so nothing ran. Once the screen was up, a person
 * may have pressed Enter just before the close reached the node, so the attempt counts (the
 * rank then needs a stop, which the node proves from status when nothing ran).
 */
function attemptsAfterServerClose(step: {
  attempts: number;
  operatorTerminalId: string | null;
  operatorSince: Date | null;
  operatorAcceptedAt: Date | null;
}): number {
  return step.operatorTerminalId !== null &&
    step.operatorSince === null &&
    step.operatorAcceptedAt === null
    ? Math.max(0, step.attempts - 1)
    : step.attempts;
}

function commandAuthor(editor: "USER" | "AGENT" | "SYSTEM"): "user" | "agent" | "unknown" {
  return editor === "USER" ? "user" : editor === "AGENT" ? "agent" : "unknown";
}

/** A step as `afterStep` needs it. */
type FinishedStep = {
  instanceId: string;
  phase: StepPhase;
  rank: number;
  generation: number;
  sequence: number;
};

/** A process just started: nodes are still reconnecting, none is marked offline yet. */
const STARTUP_GRACE_MS = 2 * 60_000;

/**
 * Start failures that repeat identically: an agent's start on a Relay-only node, a version a
 * Relay-only node does not hold. The instance FAILS (no automatic restart).
 */
const TERMINAL_START_ERRORS: ReadonlySet<string> = new Set([
  "trust_relay",
  "definition_frozen",
  // A node built without operator terminals refuses an interactive step the same way every time.
  "interactive_unsupported",
  "operator_terminals_disabled",
]);

export type LifecycleOptions = {
  /** A start step failed `definition_missing` at Full control: push the node's definitions. */
  resyncDefinitions?: (nodeId: string) => void;
  now?: () => Date;
};

type InstanceRow = Prisma.RuntimeInstanceGetPayload<{
  include: {
    Ranks: true;
    LaunchVersion: { select: { spec: true; launchHash: true; advanced: true; editor: true } };
  };
}>;

const INSTANCE_INCLUDE = {
  Ranks: true,
  LaunchVersion: { select: { spec: true, launchHash: true, advanced: true, editor: true } },
} as const;

function launchOf(instance: InstanceRow): RuntimeLaunch | null {
  const spec = instance.LaunchVersion.spec;
  const launch =
    spec && typeof spec === "object" && "launch" in spec ? Reflect.get(spec, "launch") : null;
  const parsed = runtimeLaunchSchema.safeParse(launch);
  return parsed.success ? parsed.data : null;
}

function advancedInt(
  instance: InstanceRow,
  key: "restartBudget" | "restartWindowMin" | "unhealthyRestartMs" | "unavailableStopMs",
): number {
  const advanced = instance.LaunchVersion.advanced;
  const value =
    advanced && typeof advanced === "object" && !Array.isArray(advanced)
      ? Reflect.get(advanced, key)
      : undefined;
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : RUNTIME_ADVANCED[key].auto.default;
}

function instanceInput(instance: InstanceRow): InstanceInput {
  return {
    id: instance.id,
    handle: instance.handle,
    runtimeId: instance.runtimeId,
    launchVersionId: instance.launchVersionId,
    launchHash: instance.LaunchVersion.launchHash,
    fabricId: instance.fabricId,
  };
}

function rankInput(rank: InstanceRow["Ranks"][number]): RankInput {
  return { rank: rank.rank, port: rank.port, distPort: rank.distPort, resources: rank.resources };
}

/**
 * A status probe (stop proof) is for a claim marked stopped, or a held claim of an instance that is
 * stopping (its stops could not prove the stop), sent for the run that holds it: a probe of an
 * earlier run carries that run's port and commands, so it proves nothing about a later one.
 * Anything else is the run that holds the claim now: a probe never goes out for it, and an
 * answer releases nothing.
 */
function statusProbeWanted(
  instance: { phase: string },
  claim: string | undefined,
  probeGeneration: number,
  currentGeneration: number,
): boolean {
  if (claim === "HELD_UNKNOWN") return true;
  return (
    claim === "HELD" &&
    instance.phase === "STOPPING" &&
    probeGeneration === Math.max(currentGeneration, 1)
  );
}

const STOP_PROOF_FAILURE_CODES: ReadonlySet<string> = new Set(STOP_PROOF_FAILURES);

/** Why a status probe answered not stopped (its `detail`), when the node said (newer nodes). */
function stopProofFailure(phase: string, detail: string | undefined): string | null {
  return phase === "STATUS" && detail !== undefined && STOP_PROOF_FAILURE_CODES.has(detail)
    ? detail
    : null;
}

function isStartPhase(phase: string): boolean {
  return (START_PHASES as readonly string[]).includes(phase);
}

/** A node session sends a heartbeat at least this often; older means the node is gone. */
const HEARTBEAT_STALE_MS = 3 * 60_000;

/**
 * Since when a node is offline, or null when it is online: OFFLINE rows since their
 * disconnect; ONLINE rows whose heartbeat went stale (a server that stopped abruptly never
 * wrote the disconnect) since their last heartbeat.
 */
function offlineSinceOf(
  node: { connection: string; lastDisconnectedAt: Date | null; lastHeartbeatAt: Date | null },
  now: Date,
): Date | null {
  if (node.connection === "OFFLINE") return node.lastDisconnectedAt ?? new Date(0);
  if (node.lastHeartbeatAt && node.lastHeartbeatAt.getTime() < now.getTime() - HEARTBEAT_STALE_MS)
    return node.lastHeartbeatAt;
  return null;
}

function errorName(error: unknown): string {
  return error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error;
}

export class RuntimeLifecycle {
  /** Distinguishes this process's dispatches from another replica's or an earlier run's. */
  readonly epoch = `e${randomBytes(9)
    .toString("base64url")
    .replace(/[^A-Za-z0-9]/g, "x")}`;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private readonly now: () => Date;
  private readonly startedAt = Date.now();

  constructor(
    private readonly relay: LifecycleRelay,
    private readonly options: LifecycleOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  start() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => this.wake(), TICK_MS);
    this.timer.unref?.();
    this.wake();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  /** Runs a tick now (or right after the current one). */
  wake() {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.tick()
      .catch((error: unknown) => console.error("[lifecycle] tick failed", errorName(error)))
      .finally(() => {
        this.running = null;
        if (this.again) {
          this.again = false;
          this.wake();
        }
      });
  }

  /** Joins the current tick and runs one more (tests, operational probes). */
  async runOnce() {
    await this.running;
    this.running = this.tick().finally(() => {
      this.running = null;
    });
    await this.running;
  }

  /** `Context.services.dispatchRuntimeOperation`: the operation committed; act on it now. */
  async dispatchOperation(_input: { operationId: string; userId?: string }): Promise<void> {
    this.wake();
  }

  private ownerEpoch(connectionGeneration: number) {
    return `${this.epoch}:${connectionGeneration}`;
  }

  private write<T>(userId: string, instanceId: string, work: (tx: Tx) => Promise<T>) {
    return graphWrite([userId], work, async () => instanceCapacityFences([instanceId]));
  }

  private async tick() {
    await this.prepareStarts();
    await this.reconcileStopping();
    await this.drainInactiveOwners();
    await this.restartDue();
    await this.watchLive();
    await this.expireSteps();
    await this.dispatchSteps();
    await this.probeHeldUnknown();
  }

  // ── Starts ──

  /** STARTING instances whose operation has no steps yet get a new generation. */
  private async prepareStarts() {
    const rows = await prisma.runtimeInstance.findMany({
      where: { desiredState: "RUNNING", phase: "STARTING" },
      select: { id: true, userId: true, operationId: true },
      orderBy: { phaseChangedAt: "asc" },
      take: BATCH * 4,
    });
    for (const row of rows) {
      // A start operation's generation names it; the engine's own restarts write their
      // generation in the same transaction as the restart, so they are never "unprepared".
      const prepared = await prisma.instanceStep.count({
        where: {
          instanceId: row.id,
          phase: { in: [...START_PHASES] },
          ...(row.operationId
            ? { intent: { path: ["operationId"], equals: row.operationId } }
            : {}),
        },
      });
      if (prepared > 0) continue;
      await this.write(row.userId, row.id, async (tx) => {
        const instance = await tx.runtimeInstance.findUnique({
          where: { id: row.id },
          include: INSTANCE_INCLUDE,
        });
        if (instance?.phase !== "STARTING" || instance.desiredState !== "RUNNING") return;
        if (instance.operationId !== row.operationId) return;
        // Again under the fence: another replica may have prepared it meanwhile.
        const already = await tx.instanceStep.count({
          where: {
            instanceId: row.id,
            phase: { in: [...START_PHASES] },
            ...(row.operationId
              ? { intent: { path: ["operationId"], equals: row.operationId } }
              : {}),
          },
        });
        if (already > 0) return;
        await this.createGeneration(tx, instance, instance.operationId);
      }).catch((error: unknown) =>
        console.error("[lifecycle] preparing a start failed", errorName(error)),
      );
    }
  }

  private async createGeneration(tx: Tx, instance: InstanceRow, operationId: string | null) {
    const launch = launchOf(instance);
    if (!launch) {
      // The launched version cannot be read (should not happen: versions are validated).
      await this.gangStop(tx, instance, "definition_invalid");
      return;
    }
    const latest = await tx.instanceStep.aggregate({
      where: { instanceId: instance.id, phase: { not: "HEALTH" } },
      _max: { generation: true },
    });
    const generation = (latest._max.generation ?? 0) + 1;
    const ranks = instance.Ranks.filter((rank) => rank.nodeId !== null).map(rankInput);
    const steps = generationSteps({
      instance: instanceInput(instance),
      ranks,
      launch,
      generation,
      operationId,
    });
    await this.insertSteps(tx, instance, steps);
    // Earlier probes belong to the previous run.
    await tx.instanceStep.updateMany({
      where: { instanceId: instance.id, phase: "HEALTH", state: "PENDING", attempts: 0 },
      data: { state: "CANCELLED" },
    });
    await tx.runtimeInstance.update({
      where: { id: instance.id },
      data: {
        healthFailures: 0,
        healthSuccesses: 0,
        unhealthySince: null,
        cacheGeneration: `${instance.id}:${generation}`,
      },
    });
  }

  private async insertSteps(tx: Tx, instance: InstanceRow, steps: readonly NewStep[]) {
    const nodeByRank = new Map(instance.Ranks.map((rank) => [rank.rank, rank.nodeId]));
    for (const step of steps) {
      const nodeId = nodeByRank.get(step.rank);
      if (!nodeId) continue;
      await tx.instanceStep.create({
        data: {
          instanceId: instance.id,
          nodeId,
          rank: step.rank,
          phase: step.phase,
          sequence: step.sequence,
          generation: step.generation,
          intent: step.intent,
          intentHash: step.intentHash,
        },
      });
    }
  }

  private async currentGeneration(tx: Tx, instanceId: string): Promise<number> {
    const latest = await tx.instanceStep.aggregate({
      where: { instanceId, phase: { not: "HEALTH" } },
      _max: { generation: true },
    });
    return latest._max.generation ?? 0;
  }

  // ── Stops ──

  /**
   * Ends a run: STOPPING with `reason` (the desired state is kept, so a failed RUNNING instance
   * follows the restart rule once every claim is released). Pending start and health steps are
   * cancelled; the stop steps follow in `settleStopping`.
   */
  private async gangStop(tx: Tx, instance: InstanceRow, reason: string) {
    await tx.runtimeInstance.update({
      where: { id: instance.id },
      data: {
        phase: "STOPPING",
        phaseReason: reason,
        phaseChangedAt: this.now(),
        needsOperator: null,
        needsOperatorSince: null,
      },
    });
    await this.settleStopping(tx, { ...instance, phase: "STOPPING", phaseReason: reason });
  }

  private async reconcileStopping() {
    const rows = await prisma.runtimeInstance.findMany({
      where: { phase: "STOPPING", desiredState: { not: null } },
      select: { id: true, userId: true },
      orderBy: { phaseChangedAt: "asc" },
      take: BATCH * 4,
    });
    for (const row of rows) {
      await this.write(row.userId, row.id, async (tx) => {
        const instance = await tx.runtimeInstance.findUnique({
          where: { id: row.id },
          include: INSTANCE_INCLUDE,
        });
        if (instance?.phase === "STOPPING") await this.settleStopping(tx, instance);
      }).catch((error: unknown) =>
        console.error("[lifecycle] reconciling a stop failed", errorName(error)),
      );
    }
  }

  /**
   * One pass over a STOPPING instance: cancel what no longer runs, release ranks that provably
   * never started, create stop steps for the rest, ask a person when a stop cannot be proven,
   * and settle STOPPED once every claim is released (or marked stopped).
   */
  private async settleStopping(tx: Tx, instance: InstanceRow) {
    const now = this.now();
    const generation = await this.currentGeneration(tx, instance.id);
    // Pending start-phase and health steps never run now. Never-sent ones are CANCELLED (proof
    // they never ran); a re-queued one (attempts > 0) may have run and is FAILED. A hold's
    // reason does not outlive the hold.
    await tx.instanceStep.updateMany({
      where: {
        instanceId: instance.id,
        state: "PENDING",
        phase: { in: [...START_PHASES, "HEALTH"] },
        errorCode: { in: [...OPERATOR_HOLD_CODES] },
      },
      data: { errorCode: null },
    });
    await tx.instanceStep.updateMany({
      where: {
        instanceId: instance.id,
        state: "PENDING",
        phase: { in: [...START_PHASES, "HEALTH"] },
        attempts: 0,
      },
      data: { state: "CANCELLED", operatorHold: null },
    });
    await tx.instanceStep.updateMany({
      where: {
        instanceId: instance.id,
        state: "PENDING",
        phase: { in: [...START_PHASES, "HEALTH"] },
      },
      data: { state: "FAILED", errorCode: "stopped", operatorHold: null },
    });
    // Interactive start steps still waiting for their person (or whose terminal is still
    // coming up) never run now: their terminals close. A person's run in progress is left to
    // answer; the instance's stops wait behind it (dispatch).
    await this.settleOperatorSteps(tx, instance.id, START_PHASES, "stopped");
    const launch = launchOf(instance);
    const steps = await tx.instanceStep.findMany({
      where: { instanceId: instance.id, generation, phase: { not: "HEALTH" } },
      select: {
        rank: true,
        phase: true,
        state: true,
        sequence: true,
        attempts: true,
        errorCode: true,
      },
    });
    let needsMarkStopped = false;
    // Claims as they are now (a caller's copy may predate a release in this transaction).
    const current = await tx.instanceRank.findMany({ where: { instanceId: instance.id } });
    for (const rank of current) {
      if (rank.claim !== "HELD") continue;
      const mine = steps.filter((step) => step.rank === rank.rank);
      const starts = mine.filter((step) => step.phase !== "STOP" && step.phase !== "STATUS");
      const leadingStop = mine.find(
        (step) => step.phase === "STOP" && step.sequence === generation * GENERATION_STRIDE,
      );
      // Attempts count only dispatches that may have run something (a declined operator
      // terminal, or one ended before its screen came up, gives its attempt back), so a FAILED
      // step without one never ran.
      const neverRan = starts.every(
        (step) =>
          step.state === "CANCELLED" ||
          (step.state === "PENDING" && step.attempts === 0) ||
          (step.state === "FAILED" &&
            (step.attempts === 0 || PRE_ADMISSION.has(step.errorCode ?? ""))),
      );
      const priorProven = generation <= 1 || leadingStop?.state === "SUCCEEDED";
      if (neverRan && priorProven) {
        await this.release(tx, rank.id, now);
        continue;
      }
      // This run's gang stops of the rank (not its leading stop, not status probes).
      const stops = mine.filter(
        (step) =>
          step.phase === "STOP" &&
          step.sequence >= generation * GENERATION_STRIDE + STOP_ORDER_BASE &&
          step.sequence < (generation + 1) * GENERATION_STRIDE,
      );
      // Offline too long: the stop cannot be proven until the node returns (a person may
      // mark it stopped), whether or not a stop is still queued for it.
      if (
        rank.nodeId !== null &&
        (await this.offlineSince(tx, rank.nodeId, MARK_STOPPED_AFTER_OFFLINE_MS))
      )
        needsMarkStopped = true;
      if (stops.some((step) => (LIVE_STEP_STATES as readonly string[]).includes(step.state)))
        continue;
      const failed = stops.filter((step) => step.state === "FAILED");
      if (!launch || rank.nodeId === null) {
        needsMarkStopped = true;
        continue;
      }
      if (
        failed.some((step) => UNPROVABLE_STOP.has(step.errorCode ?? "")) ||
        failed.length >= STOP_ATTEMPTS
      ) {
        // The stop itself cannot prove it, but the node may: a status probe answers stopped
        // when the rank's process tree is gone and its port is free. A person is asked to
        // mark it stopped only once a probe could not prove it (or none can be sent); the probe keeps
        // being repeated, so a later proof still completes the stop with no person.
        // A person who gave up on an interactive stop decides at once (the probe still runs).
        const probeUnproven = await this.probeStoppingRank(
          tx,
          instance,
          rank,
          launch,
          generation,
          now,
        );
        if (probeUnproven || failed.some((step) => step.errorCode === OPERATOR_CANCELLED))
          needsMarkStopped = true;
        continue;
      }
      await this.insertSteps(tx, instance, [
        stopStep({
          instance: instanceInput(instance),
          rank: rankInput(rank),
          nnodes: instance.Ranks.length,
          launch,
          generation: Math.max(generation, 1),
          attempt: stops.length,
          operationId: instance.operationId,
        }),
      ]);
    }
    const ranks = await tx.instanceRank.findMany({
      where: { instanceId: instance.id },
      select: { claim: true },
    });
    if (ranks.every((rank) => rank.claim !== "HELD")) {
      await this.settleStopped(tx, instance, now);
      return;
    }
    // An unprovable stop needs Mark as stopped; otherwise a step waiting for its person needs them.
    const need = needsMarkStopped
      ? "MARK_STOPPED"
      : (await this.operatorStepWaiting(tx, instance.id))
        ? "STEP"
        : null;
    if (instance.needsOperator !== need)
      await tx.runtimeInstance.update({
        where: { id: instance.id },
        data: { needsOperator: need, needsOperatorSince: need ? now : null },
      });
  }

  /**
   * A STOPPING rank whose stops failed: keeps one status probe (stop proof) going, at most one
   * every {@link HELD_UNKNOWN_PROBE_MS}. True when a person must decide now: the node is not
   * connected here, or an earlier probe answered without proving the stop.
   */
  private async probeStoppingRank(
    tx: Tx,
    instance: InstanceRow,
    rank: InstanceRow["Ranks"][number],
    launch: RuntimeLaunch,
    generation: number,
    now: Date,
  ): Promise<boolean> {
    if (rank.nodeId === null) return true;
    // An offline node gets its probe when it is back; a person is asked only once it has been
    // away for MARK_STOPPED_AFTER_OFFLINE_MS (a node connected to another server process is online).
    if (await this.offlineSince(tx, rank.nodeId, 0))
      return this.offlineSince(tx, rank.nodeId, MARK_STOPPED_AFTER_OFFLINE_MS);
    const probeGeneration = Math.max(generation, 1);
    const probes = await tx.instanceStep.findMany({
      where: {
        instanceId: instance.id,
        rank: rank.rank,
        generation: probeGeneration,
        phase: "STATUS",
      },
      select: { state: true, updatedAt: true },
    });
    const finished = probes.filter(
      (probe) => !(LIVE_STEP_STATES as readonly string[]).includes(probe.state),
    );
    // A probe on its way: wait for it (a person is asked only if an earlier one failed).
    if (probes.length > finished.length) return finished.length > 0;
    const latest = Math.max(0, ...finished.map((probe) => probe.updatedAt.getTime()));
    if (finished.length === 0 || latest <= now.getTime() - HELD_UNKNOWN_PROBE_MS)
      await this.insertSteps(tx, instance, [
        stopStep({
          instance: instanceInput(instance),
          rank: rankInput(rank),
          nnodes: instance.Ranks.length,
          launch,
          generation: probeGeneration,
          attempt: await this.nextStatusAttempt(tx, instance.id, rank.rank),
          operationId: null,
          phase: "STATUS",
        }),
      ]);
    return finished.length > 0;
  }

  /**
   * The attempt number of a rank's next status probe. Probe sequences are unique per rank
   * across generations (the step key has no generation), so this counts past every earlier
   * probe of the instance, not just this run's.
   */
  private async nextStatusAttempt(tx: Tx, instanceId: string, rank: number): Promise<number> {
    const latest = await tx.instanceStep.aggregate({
      where: { instanceId, rank, phase: "STATUS" },
      _max: { sequence: true },
    });
    const sequence = latest._max.sequence;
    return sequence === null ? 0 : sequence - STATUS_SEQUENCE_BASE + 1;
  }

  private async offlineSince(tx: Tx, nodeId: string, ms: number): Promise<boolean> {
    const node = await tx.node.findUnique({
      where: { id: nodeId },
      select: { connection: true, lastDisconnectedAt: true, lastHeartbeatAt: true },
    });
    const since = node ? offlineSinceOf(node, this.now()) : null;
    return since !== null && since.getTime() <= this.now().getTime() - ms;
  }

  private async release(tx: Tx, rankId: string, now: Date) {
    await tx.instanceRank.updateMany({
      where: { id: rankId, claim: { in: ["HELD", "HELD_UNKNOWN"] } },
      data: { claim: "RELEASED", claimChangedAt: now, stoppedAt: now },
    });
  }

  /** Every claim is released or marked stopped: STOPPED, then the restart rule for RUNNING. */
  private async settleStopped(tx: Tx, instance: InstanceRow, now: Date) {
    // Interactive stops still waiting for their person have nothing left to stop.
    await this.settleOperatorSteps(tx, instance.id, ["STOP"], "superseded");
    // Nothing is left to stop: pending stops are not needed any more (re-queued ones fail).
    await tx.instanceStep.updateMany({
      where: { instanceId: instance.id, phase: "STOP", state: "PENDING", attempts: 0 },
      data: { state: "CANCELLED", operatorHold: null },
    });
    await tx.instanceStep.updateMany({
      where: { instanceId: instance.id, phase: "STOP", state: "PENDING" },
      data: { state: "FAILED", errorCode: "superseded", operatorHold: null },
    });
    if (instance.desiredState !== "RUNNING") {
      await tx.runtimeInstance.update({
        where: { id: instance.id },
        data: {
          phase: "STOPPED",
          phaseChangedAt: now,
          fabricId: null,
          needsOperator: null,
          needsOperatorSince: null,
          nextRestartAt: null,
          unavailableSince: null,
        },
      });
      return;
    }
    if (instance.phaseReason !== null && TERMINAL_START_ERRORS.has(instance.phaseReason)) {
      await tx.runtimeInstance.update({
        where: { id: instance.id },
        data: {
          phase: "FAILED",
          phaseChangedAt: now,
          fabricId: null,
          nextRestartAt: null,
          unavailableSince: null,
          needsOperator: null,
          needsOperatorSince: null,
        },
      });
      return;
    }
    const launch = launchOf(instance);
    const interactiveStart =
      !!launch &&
      launch.commands.some(
        (commands) =>
          commands.interactive?.start ||
          commands.interactive?.prepare ||
          commands.interactive?.afterJoin,
      );
    if (interactiveStart) {
      // Owner decision: an interactive start is never restarted automatically.
      await tx.runtimeInstance.update({
        where: { id: instance.id },
        data: {
          phase: "STOPPED",
          phaseChangedAt: now,
          fabricId: null,
          nextRestartAt: null,
          unavailableSince: null,
          needsOperator: "RESTART",
          needsOperatorSince: now,
        },
      });
      return;
    }
    const budget = advancedInt(instance, "restartBudget");
    const windowMs = advancedInt(instance, "restartWindowMin") * 60_000;
    const windowOpen =
      instance.restartWindowStartedAt !== null &&
      now.getTime() - instance.restartWindowStartedAt.getTime() < windowMs;
    const used = windowOpen ? instance.restartsInWindow : 0;
    if (used >= budget) {
      await tx.runtimeInstance.update({
        where: { id: instance.id },
        data: {
          phase: "FAILED",
          phaseReason: "restart_budget_exhausted",
          phaseChangedAt: now,
          fabricId: null,
          nextRestartAt: null,
          unavailableSince: null,
          needsOperator: null,
          needsOperatorSince: null,
        },
      });
      return;
    }
    const backoff = Math.min(RESTART_BACKOFF_BASE_MS * 2 ** used, RESTART_BACKOFF_MAX_MS);
    await tx.runtimeInstance.update({
      where: { id: instance.id },
      data: {
        phase: "STOPPED",
        phaseChangedAt: now,
        fabricId: null,
        unavailableSince: null,
        needsOperator: null,
        needsOperatorSince: null,
        restartsInWindow: used,
        restartWindowStartedAt: windowOpen ? instance.restartWindowStartedAt : now,
        nextRestartAt: new Date(now.getTime() + backoff),
      },
    });
  }

  /** (RUNNING, STOPPED) past `nextRestartAt`: retake the claims and start a new generation. */
  private async restartDue() {
    const rows = await prisma.runtimeInstance.findMany({
      where: {
        desiredState: "RUNNING",
        phase: "STOPPED",
        nextRestartAt: { lte: this.now() },
        // An inactive owner's instance never starts (it restarts once the owner is active).
        Runtime: { User: activeOwner(this.now()) },
      },
      select: { id: true, userId: true },
      take: BATCH,
    });
    for (const row of rows) {
      await this.write(row.userId, row.id, async (tx) => {
        const instance = await tx.runtimeInstance.findUnique({
          where: { id: row.id },
          include: INSTANCE_INCLUDE,
        });
        if (
          instance?.phase !== "STOPPED" ||
          instance.desiredState !== "RUNNING" ||
          !instance.nextRestartAt ||
          instance.nextRestartAt > this.now()
        )
          return;
        // A step of the previous run still out (a stop, a probe): restart after it answers.
        const outstanding = await tx.instanceStep.count({
          where: { instanceId: instance.id, state: "RUNNING", phase: { not: "HEALTH" } },
        });
        if (outstanding > 0) {
          await tx.runtimeInstance.update({
            where: { id: instance.id },
            data: { nextRestartAt: new Date(this.now().getTime() + RETAKE_RETRY_MS) },
          });
          return;
        }
        await this.retake(tx, instance);
      }).catch(async (error: unknown) => {
        // A port retaken by another instance meanwhile: try again later.
        console.error("[lifecycle] an automatic restart failed", errorName(error));
        await this.write(row.userId, row.id, (tx) =>
          tx.runtimeInstance.updateMany({
            where: { id: row.id, phase: "STOPPED", desiredState: "RUNNING" },
            data: { nextRestartAt: new Date(this.now().getTime() + RETAKE_RETRY_MS) },
          }),
        ).catch(() => undefined);
      });
    }
  }

  private async retake(tx: Tx, instance: InstanceRow) {
    const now = this.now();
    if (instance.Ranks.some((rank) => rank.nodeId === null)) {
      // A rank's node was deleted: nothing to restart on.
      await tx.runtimeInstance.update({
        where: { id: instance.id },
        data: {
          phase: "FAILED",
          phaseReason: "node_deleted",
          phaseChangedAt: now,
          nextRestartAt: null,
        },
      });
      return;
    }
    await tx.instanceRank.updateMany({
      where: { instanceId: instance.id },
      data: {
        claim: "HELD",
        claimChangedAt: now,
        stoppedAt: null,
        markedStoppedAt: null,
        markedStoppedBy: null,
        blockedBy: [],
      },
    });
    await tx.runtimeInstance.update({
      where: { id: instance.id },
      data: {
        phase: "STARTING",
        phaseReason: "restarting",
        phaseChangedAt: now,
        nextRestartAt: null,
        restartsInWindow: { increment: 1 },
      },
    });
    const fresh = await tx.runtimeInstance.findUniqueOrThrow({
      where: { id: instance.id },
      include: INSTANCE_INCLUDE,
    });
    await this.createGeneration(tx, fresh, fresh.operationId);
  }

  // ── Live instances: readiness, health, unavailability ──

  private async watchLive() {
    const rows = await prisma.runtimeInstance.findMany({
      where: { desiredState: "RUNNING", phase: { in: [...LIVE_PHASES] } },
      select: { id: true, userId: true },
      take: BATCH * 4,
    });
    for (const row of rows) {
      await this.write(row.userId, row.id, async (tx) => {
        const instance = await tx.runtimeInstance.findUnique({
          where: { id: row.id },
          include: INSTANCE_INCLUDE,
        });
        if (instance?.desiredState !== "RUNNING") return;
        await this.watchInstance(tx, instance);
      }).catch((error: unknown) =>
        console.error("[lifecycle] watching an instance failed", errorName(error)),
      );
    }
    await this.pruneHealth();
  }

  private async watchInstance(tx: Tx, instance: InstanceRow) {
    const now = this.now();
    const nodeIds = instance.Ranks.flatMap((rank) => (rank.nodeId ? [rank.nodeId] : []));
    // The durable connection state (any replica's sessions), not this process's map. Right
    // after this process started, nodes are still reconnecting: nothing is marked yet.
    const rows = await tx.node.findMany({
      where: { id: { in: nodeIds } },
      select: { id: true, connection: true, lastDisconnectedAt: true, lastHeartbeatAt: true },
    });
    const onlineIds = new Set(
      rows.filter((node) => offlineSinceOf(node, now) === null).map((node) => node.id),
    );
    const offline = nodeIds.filter((nodeId) => !onlineIds.has(nodeId));
    if (offline.length > 0 && now.getTime() - this.startedAt < STARTUP_GRACE_MS) return;
    if (offline.length > 0 || nodeIds.length !== instance.Ranks.length) {
      if (instance.phase !== "UNAVAILABLE") {
        await tx.runtimeInstance.update({
          where: { id: instance.id },
          data: {
            phase: "UNAVAILABLE",
            phaseReason: "node_offline",
            phaseChangedAt: now,
            unavailableSince: instance.unavailableSince ?? now,
          },
        });
        return;
      }
      const since = instance.unavailableSince ?? instance.phaseChangedAt;
      // A rank whose node was deleted never comes back: stop now. Otherwise the online ranks
      // of a multi-node instance stop after unavailableStopMs (their GPUs are freed).
      if (nodeIds.length !== instance.Ranks.length)
        await this.gangStop(tx, instance, "node_deleted");
      else if (
        instance.Ranks.length > 1 &&
        now.getTime() - since.getTime() >= advancedInt(instance, "unavailableStopMs")
      )
        await this.gangStop(tx, instance, "node_offline");
      return;
    }
    if (instance.phase === "UNAVAILABLE") {
      // Back: READY if this run had reached readiness (health probes confirm), else STARTING.
      const generation = await this.currentGeneration(tx, instance.id);
      const ready = await tx.instanceStep.count({
        where: { instanceId: instance.id, generation, phase: "READINESS", state: "SUCCEEDED" },
      });
      await tx.runtimeInstance.update({
        where: { id: instance.id },
        data: {
          phase: ready ? "READY" : "STARTING",
          phaseReason: null,
          phaseChangedAt: now,
          unavailableSince: null,
        },
      });
      return;
    }
    if (instance.phase === "UNHEALTHY" && instance.unhealthySince) {
      if (
        now.getTime() - instance.unhealthySince.getTime() >=
        advancedInt(instance, "unhealthyRestartMs")
      ) {
        await this.gangStop(tx, instance, "health_failed");
        return;
      }
    }
    if (instance.phase === "READY" || instance.phase === "UNHEALTHY")
      await this.scheduleHealth(tx, instance);
  }

  private async scheduleHealth(tx: Tx, instance: InstanceRow) {
    const launch = launchOf(instance);
    if (!launch) return;
    const due =
      !instance.lastHealthAt ||
      this.now().getTime() - instance.lastHealthAt.getTime() >= launch.health.intervalMs;
    if (!due) return;
    const live = await tx.instanceStep.count({
      where: { instanceId: instance.id, phase: "HEALTH", state: { in: ["PENDING", "RUNNING"] } },
    });
    if (live > 0) return;
    const head = instance.Ranks.find((rank) => rank.rank === 0);
    if (!head?.nodeId) return;
    const latest = await tx.instanceStep.aggregate({
      where: { instanceId: instance.id, phase: "HEALTH" },
      _max: { sequence: true },
    });
    await this.insertSteps(tx, instance, [
      healthStep({
        instance: instanceInput(instance),
        head: rankInput(head),
        nnodes: instance.Ranks.length,
        launch,
        generation: await this.currentGeneration(tx, instance.id),
        sequence: (latest._max.sequence ?? HEALTH_SEQUENCE_BASE - 1) + 1,
      }),
    ]);
  }

  private async pruneHealth() {
    // Finished probes only (bounded: a WHERE on phase, state and age).
    await prisma.instanceStep
      .findMany({
        where: {
          phase: "HEALTH",
          state: { in: ["SUCCEEDED", "FAILED", "CANCELLED"] },
          updatedAt: { lt: new Date(this.now().getTime() - HEALTH_HISTORY_MS) },
        },
        select: { id: true, Instance: { select: { userId: true, id: true } } },
        take: BATCH * 4,
      })
      .then(async (rows) => {
        const byOwner = new Map<string, string[]>();
        for (const row of rows) {
          const list = byOwner.get(row.Instance.userId) ?? [];
          list.push(row.id);
          byOwner.set(row.Instance.userId, list);
        }
        for (const [userId, ids] of byOwner)
          await graphWrite([userId], (tx) =>
            tx.instanceStep.deleteMany({ where: { id: { in: ids }, phase: "HEALTH" } }),
          );
      })
      .catch((error: unknown) =>
        console.error("[lifecycle] pruning probes failed", errorName(error)),
      );
  }

  // ── Deadlines ──

  private async expireSteps() {
    const now = this.now();
    const rows = await prisma.instanceStep.findMany({
      where: {
        state: "RUNNING",
        deadline: { lte: now },
        OR: [
          // A person's run is never expired; only its need is raised (once, below).
          { operatorAcceptedAt: null },
          { Instance: { needsOperator: null } },
        ],
      },
      select: { id: true, instanceId: true, Instance: { select: { userId: true } } },
      orderBy: { deadline: "asc" },
      take: BATCH,
    });
    for (const row of rows) {
      await this.write(row.Instance.userId, row.instanceId, async (tx) => {
        const step = await tx.instanceStep.findUnique({ where: { id: row.id } });
        if (step?.state !== "RUNNING" || !step.deadline || step.deadline > this.now()) return;
        if (interactiveIntent(step.intent)) {
          // A person's run is never cut off: past its timeout it needs its person again.
          if (step.operatorAcceptedAt) await this.syncNeedsOperator(tx, step.instanceId);
          // No confirm screen in time: dispatched again with a fresh terminal.
          else await this.reissueOperatorStep(tx, step);
          return;
        }
        await tx.instanceStep.updateMany({
          where: { id: step.id, state: "RUNNING" },
          data: {
            state: "FAILED",
            errorCode: "job_deadline",
            leaseExpiresAt: null,
            deadline: null,
          },
        });
        await this.afterStep(tx, step, false, "job_deadline");
      }).catch((error: unknown) =>
        console.error("[lifecycle] expiring a step failed", errorName(error)),
      );
    }
  }

  // ── Dispatch ──

  private async dispatchSteps() {
    const online = this.relay.onlineNodeIds?.();
    if (online && online.length === 0) return;
    const rows = await prisma.instanceStep.findMany({
      where: {
        state: "PENDING",
        AND: [
          { OR: [{ notBefore: null }, { notBefore: { lte: this.now() } }] },
          // Stops and status probes go out for every owner; nothing else for an inactive one
          // (claimStep checks again under the fence).
          {
            OR: [
              { phase: { in: ["STOP", "STATUS"] } },
              { Instance: { Runtime: { User: activeOwner(this.now()) } } },
            ],
          },
        ],
        // Steps that can go now: on a connected node.
        ...(online ? { nodeId: { in: online } } : {}),
      },
      select: { id: true, nodeId: true, instanceId: true, Instance: { select: { userId: true } } },
      orderBy: [{ sequence: "asc" }, { createdAt: "asc" }],
      take: BATCH * 4,
    });
    for (const row of rows) {
      const session = this.relay.nodeSession(row.nodeId);
      // Defence in depth: a step goes only to a node of its instance's owner (claimStep checks
      // the node row too; the SQL trigger instance_step_node_owner the step's node).
      if (!session || !nodeOwnerMatches(session, row.Instance.userId, "runtime_step")) continue;
      let job: ReturnType<typeof jobFrame> | null = null;
      try {
        job = await this.write(row.Instance.userId, row.instanceId, (tx) =>
          this.claimStep(tx, row.id, session),
        );
      } catch (error) {
        console.error("[lifecycle] claiming a step failed", errorName(error));
      }
      if (!job) continue;
      const sent = this.relay.sendToNode(row.nodeId, job, {
        connectionGeneration: session.connectionGeneration,
        userId: row.Instance.userId,
        ownerCheck: "runtime_step",
      });
      if (!sent) await this.undeliver(row.Instance.userId, row.instanceId, row.id, job.ownerEpoch);
    }
  }

  /** Checks a PENDING step may run now and claims it (RUNNING, lease, attempt). */
  private async claimStep(
    tx: Tx,
    stepId: string,
    session: { connectionGeneration: number; trust: NodeTrustWire; operatorTerminals?: boolean },
  ) {
    const now = this.now();
    const step = await tx.instanceStep.findUnique({
      where: { id: stepId },
      include: { Instance: { include: INSTANCE_INCLUDE } },
    });
    if (step?.state !== "PENDING") return null;
    if (step.notBefore && step.notBefore > now) return null;
    const instance = step.Instance;
    const intent = stepIntentSchema.safeParse(step.intent);
    if (!intent.success) {
      await this.failStep(tx, step.id, "bad_job");
      await this.afterStep(tx, step, false, "bad_job");
      return null;
    }
    // A gang stop for a claim released meanwhile has nothing to stop (a leading stop of a new
    // run always has its claim HELD).
    if (step.phase === "STOP" || step.phase === "STATUS") {
      const claim = instance.Ranks.find((rank) => rank.rank === step.rank)?.claim;
      // A stop of an earlier run, or a probe of a claim that is no longer marked stopped, would act
      // on the run that holds the claim now: it never goes out.
      const superseded =
        (step.phase === "STOP" &&
          step.generation < (await this.currentGeneration(tx, instance.id))) ||
        (step.phase === "STATUS" &&
          !statusProbeWanted(
            instance,
            claim,
            step.generation,
            await this.currentGeneration(tx, instance.id),
          ));
      if (claim === "RELEASED" || superseded) {
        await tx.instanceStep.updateMany({
          where: { id: step.id, state: "PENDING" },
          data:
            step.attempts === 0
              ? { state: "CANCELLED", operatorHold: null }
              : { state: "FAILED", errorCode: "released", operatorHold: null },
        });
        if (step.operatorHold !== null) await this.syncNeedsOperator(tx, instance.id);
        return null;
      }
    }
    const startPhase = isStartPhase(step.phase);
    if (startPhase || step.phase === "HEALTH") {
      // A step of an earlier run (re-queued after a lost session) never runs in a later one.
      if (step.generation < (await this.currentGeneration(tx, instance.id))) {
        await tx.instanceStep.updateMany({
          where: { id: step.id, state: "PENDING" },
          data:
            step.attempts === 0
              ? { state: "CANCELLED", operatorHold: null }
              : { state: "FAILED", errorCode: "superseded", operatorHold: null },
        });
        if (step.operatorHold !== null) await this.syncNeedsOperator(tx, instance.id);
        return null;
      }
      if (instance.desiredState !== "RUNNING") return null;
      if (startPhase && instance.phase !== "STARTING") return null;
      if (step.phase === "HEALTH" && instance.phase !== "READY" && instance.phase !== "UNHEALTHY")
        return null;
      // A banned or deleting owner's instance never starts (or runs anything but stops and
      // status probes); the step waits, and is cancelled if a person would have to answer it.
      if (!(await this.ownerActive(tx, instance.userId))) return null;
    }
    const node = await tx.node.findUnique({
      where: { id: step.nodeId },
      select: {
        userId: true,
        trust: true,
        trustLowerRequestedAt: true,
        connectionGeneration: true,
      },
    });
    if (!node || !nodeOwnerMatches(node, instance.userId, "runtime_step")) return null;
    if (node.connectionGeneration !== session.connectionGeneration) return null;
    const fullControl =
      node.trust === "FULL" && node.trustLowerRequestedAt === null && session.trust === "full";
    // Agents cannot start anything on a Relay-only node, on any path (owner decision).
    if (startPhase && !fullControl && instance.startedBy === "AGENT") {
      await this.failStep(tx, step.id, "trust_relay");
      await this.afterStep(tx, step, false, "trust_relay");
      return null;
    }
    if (startPhase) {
      // In order: every lower step of this generation succeeded.
      const lower = await tx.instanceStep.count({
        where: {
          instanceId: instance.id,
          generation: step.generation,
          sequence: { lt: step.sequence },
          phase: { in: [...START_PHASES, "STOP"] },
          state: { not: "SUCCEEDED" },
        },
      });
      if (lower > 0) return null;
      // Queued behind instances this operation stops: wait until they released.
      const blockers = [...new Set(instance.Ranks.flatMap((rank) => rank.blockedBy))];
      if (blockers.length > 0) {
        // Only the blockers' claims on the nodes this start uses: a blocker rank stuck on
        // another (offline) node frees nothing here and must not hold the start forever.
        const startNodes = instance.Ranks.flatMap((rank) => (rank.nodeId ? [rank.nodeId] : []));
        const holding = await tx.instanceRank.count({
          where: { instanceId: { in: blockers }, claim: "HELD", nodeId: { in: startNodes } },
        });
        if (holding > 0) return null;
        // Released: a later start of a blocker must not hold this instance back again.
        await tx.instanceRank.updateMany({
          where: { instanceId: instance.id },
          data: { blockedBy: [] },
        });
      }
      if (instance.Ranks.some((rank) => rank.claim !== "HELD")) return null;
    }
    // A stop is never sent over a person's run of this instance: it waits until that run
    // answers (and is neither failed nor counted meanwhile).
    // Nor a status probe: it could see the service stopped before the run brings it up.
    if (
      (step.phase === "STOP" || step.phase === "STATUS") &&
      (await this.operatorRunInProgress(tx, step))
    )
      return null;
    const interactive = intent.data.interactive;
    if (interactive) {
      // A banned or deleting owner could never answer the terminal: none opens (the drain
      // cancels the step, see drainInactiveOwners).
      if (!(await this.ownerActive(tx, instance.userId))) return null;
      const hold = await this.operatorHold(tx, step, session);
      if (hold === "wait") {
        // Only its turn is missing now: an earlier hold no longer explains the wait.
        if (step.operatorHold !== null) await this.clearOperatorHold(tx, step);
        return null;
      }
      if (hold) {
        await this.recordOperatorHold(tx, step, hold);
        return null;
      }
    }
    let headAddr: string | null = null;
    if (intent.data.nnodes > 1) {
      const head = instance.Ranks.find((rank) => rank.rank === 0);
      if (intent.data.fabricId && head?.nodeId) {
        const member = await tx.fabricMember.findFirst({
          where: { fabricId: intent.data.fabricId, nodeId: head.nodeId, userId: instance.userId },
          select: { ip: true },
        });
        headAddr = member?.ip ?? null;
      }
      if (!headAddr) {
        await this.failStep(tx, step.id, "bad_job");
        await this.afterStep(tx, step, false, "bad_job");
        return null;
      }
    }
    const ownerEpoch = this.ownerEpoch(session.connectionGeneration);
    // A fresh terminal per dispatch (ids are never reused), with who wrote the command.
    const operator = interactive
      ? {
          terminalId: randomBytes(16).toString("base64url"),
          commandAuthor: commandAuthor(instance.LaunchVersion.editor),
        }
      : undefined;
    // An interactive job's deadline here bounds only its terminal coming up; the person's run
    // gets the step's timeout from `operator_running`.
    const deadline = new Date(
      now.getTime() +
        (operator
          ? Math.min(intent.data.timeoutMs, OPERATOR_SPAWN_BUDGET_MAX_MS) + OPERATOR_SPAWN_GRACE_MS
          : intent.data.timeoutMs),
    );
    const claimed = await tx.instanceStep.updateMany({
      where: { id: step.id, state: "PENDING" },
      data: {
        state: "RUNNING",
        ownerEpoch,
        attempts: { increment: 1 },
        deadline,
        leaseExpiresAt: deadline,
        notBefore: null,
        operatorHold: null,
        ...(operator ? { operatorTerminalId: operator.terminalId } : {}),
        ...(step.errorCode && OPERATOR_HOLD_CODES.has(step.errorCode) ? { errorCode: null } : {}),
      },
    });
    if (claimed.count === 0) return null;
    // The claim cleared a hold (CHECK: holds only on PENDING): the need follows.
    if (step.operatorHold !== null) await this.syncNeedsOperator(tx, instance.id);
    return jobFrame({
      stepId: step.id,
      instanceId: instance.id,
      phase: step.phase,
      generation: step.generation,
      intent: intent.data,
      intentHash: step.intentHash,
      ownerEpoch,
      headAddr,
      ...(operator ? { operator } : {}),
    });
  }

  /** The frame did not leave: the step goes back to PENDING without counting an attempt. */
  private async undeliver(userId: string, instanceId: string, stepId: string, ownerEpoch: string) {
    await this.write(userId, instanceId, (tx) =>
      tx.instanceStep.updateMany({
        where: { id: stepId, state: "RUNNING", ownerEpoch },
        data: {
          state: "PENDING",
          ownerEpoch: null,
          deadline: null,
          leaseExpiresAt: null,
          attempts: { decrement: 1 },
          ...NO_OPERATOR,
        },
      }),
    ).catch((error: unknown) =>
      console.error("[lifecycle] returning an undelivered step failed", errorName(error)),
    );
  }

  private async failStep(tx: Tx, stepId: string, code: string) {
    await tx.instanceStep.updateMany({
      where: { id: stepId, state: { in: ["PENDING", "RUNNING"] } },
      data: {
        state: "FAILED",
        errorCode: code,
        deadline: null,
        leaseExpiresAt: null,
        operatorHold: null,
        operatorTerminalId: null,
      },
    });
  }

  // ── Operator terminals (interactive steps) ──

  /**
   * Whether a step of the instance waits for its person: an interactive step AWAITING_OPERATOR
   * (terminal open or closed), a held one, or a person's run past its timeout.
   */
  private async operatorStepWaiting(tx: Tx, instanceId: string): Promise<boolean> {
    const waiting = await tx.instanceStep.count({
      where: {
        instanceId,
        OR: [
          { state: "AWAITING_OPERATOR" },
          { state: "PENDING", operatorHold: { not: null } },
          { state: "RUNNING", operatorAcceptedAt: { not: null }, deadline: { lte: this.now() } },
        ],
      },
    });
    return waiting > 0;
  }

  /**
   * `needsOperator` STEP while a step waits for its person; it clears when none does. MARK_STOPPED
   * (only while STOPPING, see settleStopping) and RESTART are kept.
   */
  private async syncNeedsOperator(tx: Tx, instanceId: string) {
    const instance = await tx.runtimeInstance.findUnique({
      where: { id: instanceId },
      select: { needsOperator: true },
    });
    // MARK_STOPPED and RESTART are decided by the stop and restart rules, never by a step.
    if (
      !instance ||
      instance.needsOperator === "MARK_STOPPED" ||
      instance.needsOperator === "RESTART"
    )
      return;
    const waiting = await this.operatorStepWaiting(tx, instanceId);
    const need = waiting
      ? "STEP"
      : instance.needsOperator === "STEP"
        ? null
        : instance.needsOperator;
    if (need === instance.needsOperator) return;
    await tx.runtimeInstance.update({
      where: { id: instanceId },
      data: { needsOperator: need, needsOperatorSince: need ? this.now() : null },
    });
  }

  /** Record (once) why a PENDING interactive step is held; the instance needs its person. */
  private async recordOperatorHold(tx: Tx, step: StepRow, reason: string) {
    const codeChanges =
      step.errorCode !== reason &&
      (step.errorCode === null || OPERATOR_HOLD_CODES.has(step.errorCode));
    if (step.operatorHold === reason && !codeChanges) return;
    await tx.instanceStep.updateMany({
      where: { id: step.id, state: "PENDING" },
      data: { operatorHold: reason, ...(codeChanges ? { errorCode: reason } : {}) },
    });
    await this.syncNeedsOperator(tx, step.instanceId);
  }

  private async clearOperatorHold(tx: Tx, step: StepRow) {
    await tx.instanceStep.updateMany({
      where: { id: step.id, state: "PENDING" },
      data: {
        operatorHold: null,
        ...(step.errorCode && OPERATOR_HOLD_CODES.has(step.errorCode) ? { errorCode: null } : {}),
      },
    });
    await this.syncNeedsOperator(tx, step.instanceId);
  }

  /**
   * Why an interactive step may not open its terminal now: a hold code (recorded, the person
   * is told), "wait" (not its turn: another interactive start step of this run is live, or one
   * of the same sequence has a lower rank; a person answers one terminal at a time, in recipe
   * order), or null (it may). Stops are exempt from the node cap and the turn.
   */
  private async operatorHold(
    tx: Tx,
    step: StepRow,
    session: { operatorTerminals?: boolean },
  ): Promise<string | null> {
    if (session.operatorTerminals !== true) return OPERATOR_HOLD.capabilityMissing;
    if (this.relay.operatorRoom && !this.relay.operatorRoom(step.nodeId))
      return OPERATOR_HOLD.sessionFull;
    if (step.phase === "STOP") return null;
    const live = await tx.instanceStep.count({
      where: {
        nodeId: step.nodeId,
        phase: { not: "STOP" },
        state: { in: ["RUNNING", "AWAITING_OPERATOR"] },
        operatorTerminalId: { not: null },
      },
    });
    if (live >= OPERATOR_TERMINALS_PER_NODE) return OPERATOR_HOLD.nodeFull;
    const others = await tx.instanceStep.findMany({
      where: {
        instanceId: step.instanceId,
        id: { not: step.id },
        generation: step.generation,
        phase: { in: [...START_PHASES] },
        OR: [
          {
            state: { in: ["RUNNING", "AWAITING_OPERATOR"] },
            OR: [{ operatorTerminalId: { not: null } }, { operatorSince: { not: null } }],
          },
          { state: "PENDING", sequence: step.sequence, rank: { lt: step.rank } },
        ],
      },
      select: { state: true, intent: true },
    });
    return others.some((other) => other.state !== "PENDING" || interactiveIntent(other.intent))
      ? "wait"
      : null;
  }

  /**
   * End the interactive steps of these phases that wait for their person (AWAITING_OPERATOR, or
   * RUNNING with a terminal that has not come up yet) and close their terminals. A person's run
   * in progress is left to answer. A dispatch whose screen never came up gives its attempt back
   * ({@link attemptsAfterServerClose}), so a step that never ran ends CANCELLED (proof for the
   * claim's auto-release), else FAILED `code`.
   */
  private async settleOperatorSteps(
    tx: Tx,
    instanceId: string,
    phases: readonly StepPhase[],
    code: string,
  ): Promise<number> {
    const steps = await tx.instanceStep.findMany({
      where: {
        instanceId,
        phase: { in: [...phases] },
        OR: [
          { state: "AWAITING_OPERATOR" },
          { state: "RUNNING", operatorTerminalId: { not: null }, operatorAcceptedAt: null },
        ],
      },
    });
    let settled = 0;
    for (const step of steps) {
      if (!interactiveIntent(step.intent)) continue;
      if (this.relay.closeOperatorStep?.(step.id, { keepRunning: true }) === "running") continue;
      const attempts = attemptsAfterServerClose(step);
      const changed = await tx.instanceStep.updateMany({
        where: { id: step.id, state: step.state, ownerEpoch: step.ownerEpoch },
        data: {
          state: attempts === 0 ? "CANCELLED" : "FAILED",
          errorCode: attempts === 0 ? null : code,
          attempts,
          deadline: null,
          leaseExpiresAt: null,
          operatorTerminalId: null,
        },
      });
      settled += changed.count;
    }
    if (settled > 0) await this.syncNeedsOperator(tx, instanceId);
    return settled;
  }

  /**
   * Return an interactive step to PENDING so it is dispatched again with a fresh terminal (the
   * node checks status first). Its terminal, if any, is closed first by step id; a terminal
   * whose command already runs is left alone and the step kept, so one step never has two
   * runs. Only a dispatch whose screen never came up gives its attempt back.
   */
  private async reissueOperatorStep(tx: Tx, step: StepRow): Promise<boolean> {
    if (this.relay.closeOperatorStep?.(step.id, { keepRunning: true }) === "running") return false;
    const changed = await tx.instanceStep.updateMany({
      where: { id: step.id, state: step.state, ownerEpoch: step.ownerEpoch },
      data: {
        state: "PENDING",
        ownerEpoch: null,
        deadline: null,
        leaseExpiresAt: null,
        ...NO_OPERATOR,
        attempts: attemptsAfterServerClose(step),
      },
    });
    if (changed.count === 0) return false;
    await this.syncNeedsOperator(tx, step.instanceId);
    return true;
  }

  /**
   * Operator progress for the current dispatch of an interactive step:
   * - `awaiting_operator`: the confirm screen is up and waits for its person: AWAITING_OPERATOR,
   *   no deadline.
   * - `operator_running`: the person pressed Enter: RUNNING with the step's deadline.
   * - `operator_closed`: see {@link operatorClosed}.
   */
  private async operatorProgress(tx: Tx, step: StepRow, result: JobResult): Promise<void> {
    if (result.status === "operator_closed") {
      await this.operatorClosed(tx, step, {
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      });
      return;
    }
    const where = {
      id: step.id,
      state: step.state,
      ownerEpoch: step.ownerEpoch,
      operatorTerminalId: step.operatorTerminalId,
    };
    const now = this.now();
    if (result.status === "awaiting_operator") {
      if (step.state === "AWAITING_OPERATOR" || step.operatorAcceptedAt !== null) return;
      const changed = await tx.instanceStep.updateMany({
        where,
        data: {
          state: "AWAITING_OPERATOR",
          deadline: null,
          leaseExpiresAt: null,
          operatorSince: step.operatorSince ?? now,
        },
      });
      if (changed.count > 0) await this.syncNeedsOperator(tx, step.instanceId);
      return;
    }
    // operator_running: a repeat, or a run reported before its screen, changes nothing.
    if (step.state !== "AWAITING_OPERATOR") return;
    const intent = stepIntentSchema.parse(step.intent);
    const deadline = new Date(now.getTime() + intent.timeoutMs);
    const changed = await tx.instanceStep.updateMany({
      where,
      data: { state: "RUNNING", deadline, leaseExpiresAt: deadline, operatorAcceptedAt: now },
    });
    if (changed.count > 0) await this.syncNeedsOperator(tx, step.instanceId);
  }

  /**
   * The operator terminal ended without success (declined, closed, the command exited non-zero,
   * or the node could not hold it: `error`). The step keeps waiting for its person with no
   * terminal (reopenable, which returns it to PENDING); claims stay held. Nothing is retried
   * automatically, so a node that cannot open a terminal never loops. A decline (nothing ran in
   * this terminal) is not an attempt.
   */
  private async operatorClosed(
    tx: Tx,
    step: StepRow,
    closed: { exitCode?: number; error?: string },
  ): Promise<void> {
    const changed = await tx.instanceStep.updateMany({
      where: {
        id: step.id,
        state: step.state,
        ownerEpoch: step.ownerEpoch,
        operatorTerminalId: step.operatorTerminalId,
      },
      data: {
        state: "AWAITING_OPERATOR",
        deadline: null,
        leaseExpiresAt: null,
        operatorTerminalId: null,
        operatorSince: step.operatorSince ?? this.now(),
        ...(closed.exitCode !== undefined ? { operatorLastExit: closed.exitCode } : {}),
        ...(closed.error ? { errorCode: closed.error } : {}),
        ...(closed.exitCode === undefined && step.operatorAcceptedAt === null
          ? { attempts: Math.max(0, step.attempts - 1) }
          : {}),
      },
    });
    if (changed.count > 0) await this.syncNeedsOperator(tx, step.instanceId);
  }

  /**
   * Whether the instance on this node has a person's run in progress (`operator_running` seen
   * and not yet answered). Its stops wait behind it: never sent over it, never failed for it.
   */
  private async operatorRunInProgress(tx: Tx, step: StepRow): Promise<boolean> {
    // Also a terminal still open on the node: its run may have begun before its report (the
    // node holds a stop behind it too, on the rank's lock).
    const running = await tx.instanceStep.count({
      where: {
        instanceId: step.instanceId,
        nodeId: step.nodeId,
        id: { not: step.id },
        OR: [
          { state: "RUNNING", operatorAcceptedAt: { not: null } },
          { state: "AWAITING_OPERATOR", operatorTerminalId: { not: null } },
        ],
      },
    });
    return running > 0;
  }

  /** The step a person reopens or cancels: theirs, interactive. */
  private async ownedOperatorStep(tx: Tx, userId: string, stepId: string) {
    const step = await tx.instanceStep.findFirst({
      where: { id: stepId, Instance: { userId } },
      include: { Instance: { include: INSTANCE_INCLUDE } },
    });
    if (!step) throw new OperatorStepError("not_found");
    if (!interactiveIntent(step.intent)) throw new OperatorStepError("not_interactive");
    return step;
  }

  /**
   * `runtimes.steps.reopen`: a step whose terminal closed without success runs again in a fresh
   * terminal (PENDING; the next dispatch opens it). Refused while its terminal is still open, or
   * once the step is no longer the instance's step to run.
   */
  async reopenStep(input: { userId: string; stepId: string }): Promise<void> {
    const instanceId = await prisma.instanceStep
      .findFirst({
        where: { id: input.stepId, Instance: { userId: input.userId } },
        select: { instanceId: true },
      })
      .then((row) => row?.instanceId);
    if (!instanceId) throw new OperatorStepError("not_found");
    await this.write(input.userId, instanceId, async (tx) => {
      const step = await this.ownedOperatorStep(tx, input.userId, input.stepId);
      if (step.state !== "AWAITING_OPERATOR" || step.operatorTerminalId !== null)
        throw new OperatorStepError("not_waiting");
      const instance = step.Instance;
      if (isStartPhase(step.phase)) {
        const current =
          step.generation === (await this.currentGeneration(tx, instance.id)) &&
          instance.desiredState === "RUNNING" &&
          instance.phase === "STARTING";
        if (!current) throw new OperatorStepError("superseded");
        // An agent's start never runs interactively on a Relay-only node: say so now.
        if (instance.startedBy === "AGENT" && !(await this.nodeFullControl(tx, step.nodeId)))
          throw new OperatorStepError("trust_relay");
      }
      const changed = await tx.instanceStep.updateMany({
        where: { id: step.id, state: "AWAITING_OPERATOR", operatorTerminalId: null },
        data: {
          state: "PENDING",
          ownerEpoch: null,
          deadline: null,
          leaseExpiresAt: null,
          notBefore: null,
          ...NO_OPERATOR,
          ...(step.errorCode === "operator_terminals_disabled" ? { errorCode: null } : {}),
        },
      });
      if (changed.count === 0) throw new OperatorStepError("not_waiting");
      await this.syncNeedsOperator(tx, instance.id);
    });
    this.wake();
  }

  /**
   * `runtimes.steps.cancel`: a person gives up on an interactive step that waits for them (or is
   * held, or whose terminal is coming up). It fails `operator_cancelled` and the instance follows
   * its rules: a start gang-stops (an interactive start then waits for a person's restart), a
   * stop needs Mark as stopped. A person's run in progress is not cut off (`running`).
   */
  async cancelStep(input: { userId: string; stepId: string }): Promise<void> {
    const instanceId = await prisma.instanceStep
      .findFirst({
        where: { id: input.stepId, Instance: { userId: input.userId } },
        select: { instanceId: true },
      })
      .then((row) => row?.instanceId);
    if (!instanceId) throw new OperatorStepError("not_found");
    await this.write(input.userId, instanceId, async (tx) => {
      const step = await this.ownedOperatorStep(tx, input.userId, input.stepId);
      const waiting =
        step.state === "AWAITING_OPERATOR" ||
        step.state === "PENDING" ||
        (step.state === "RUNNING" && step.operatorAcceptedAt === null);
      if (step.state === "RUNNING" && step.operatorAcceptedAt !== null)
        throw new OperatorStepError("running");
      if (!waiting) throw new OperatorStepError("not_waiting");
      if (
        this.relay.closeOperatorStep?.(step.id, { keepRunning: true, actor: "USER" }) === "running"
      )
        throw new OperatorStepError("running");
      const attempts = attemptsAfterServerClose(step);
      const changed = await tx.instanceStep.updateMany({
        where: { id: step.id, state: step.state, ownerEpoch: step.ownerEpoch },
        data: {
          state: "FAILED",
          errorCode: OPERATOR_CANCELLED,
          attempts,
          deadline: null,
          leaseExpiresAt: null,
          operatorHold: null,
          operatorTerminalId: null,
        },
      });
      if (changed.count === 0) throw new OperatorStepError("not_waiting");
      await this.syncNeedsOperator(tx, instanceId);
      await this.afterStep(tx, step, false, OPERATOR_CANCELLED);
    });
    this.wake();
  }

  // ── Inactive (banned or deleting) owners ──

  private async ownerActive(tx: Tx, userId: string): Promise<boolean> {
    const owner = await tx.user.findUnique({
      where: { id: userId },
      select: { banned: true, banExpires: true, deletionRequestedAt: true },
    });
    return !!owner && !userCredentialAccessBlocked(owner, this.now());
  }

  /** Where the next drain pass continues (instances by id; null: from the start). */
  private drainCursor: string | null = null;

  /**
   * Banned or deletion-pending owners (§3.5 S): nobody may answer their interactive steps, so
   * the ones waiting for a person (held, terminal coming up, open or closed) are cancelled and
   * their terminals closed. A person's run already in progress is left to answer. A cancelled
   * start gang-stops its instance; a rank whose interactive stop is cancelled (or whose latest
   * stop of this run is a failed interactive one) becomes HELD_UNKNOWN: the service may still
   * run, so placement keeps counting it until a status probe proves the stop. The instance then
   * settles. Non-interactive stops still go out; starts never do (dispatch).
   */
  private async drainInactiveOwners() {
    const now = this.now();
    const interactive = { path: ["interactive"], equals: true };
    const rows = await prisma.runtimeInstance.findMany({
      where: {
        ...(this.drainCursor ? { id: { gt: this.drainCursor } } : {}),
        Runtime: { User: inactiveOwner(now) },
        OR: [
          {
            Steps: {
              some: {
                intent: interactive,
                OR: [
                  { state: { in: ["PENDING", "AWAITING_OPERATOR"] } },
                  { state: "RUNNING", operatorAcceptedAt: null },
                ],
              },
            },
          },
          {
            phase: { in: ["STOPPING", "STARTING"] },
            Ranks: { some: { claim: "HELD" } },
            Steps: {
              some: { phase: "STOP", state: { in: ["FAILED", "CANCELLED"] }, intent: interactive },
            },
          },
        ],
      },
      select: { id: true, userId: true },
      orderBy: { id: "asc" },
      take: BATCH,
    });
    this.drainCursor = rows.length === BATCH ? (rows.at(-1)?.id ?? null) : null;
    for (const row of rows) {
      if (this.stopped) return;
      // Plain reads first: an instance matched only by history (an older run's failed stop, a
      // person's run in progress) costs no fenced transaction.
      if (!(await this.drainWork(prisma, row.id))) continue;
      await this.write(row.userId, row.id, (tx) =>
        this.drainInstance(tx, row.id, row.userId),
      ).catch((error: unknown) =>
        console.error("[lifecycle] draining an inactive owner failed", errorName(error)),
      );
    }
  }

  /** Interactive steps of the instance that wait for a person (what the drain cancels). */
  private async waitingInteractiveSteps(db: Tx, instanceId: string): Promise<StepRow[]> {
    const steps = await db.instanceStep.findMany({
      where: {
        instanceId,
        OR: [
          { state: { in: ["PENDING", "AWAITING_OPERATOR"] } },
          { state: "RUNNING", operatorAcceptedAt: null, operatorTerminalId: { not: null } },
        ],
      },
    });
    return steps.filter((step) => interactiveIntent(step.intent));
  }

  /**
   * HELD ranks of a stopping (or restarting) instance whose latest stop of the current run is an
   * interactive one that failed or was cancelled: nobody can answer it again.
   */
  private async unanswerableStopRanks(
    db: Tx,
    instance: {
      id: string;
      phase: string;
      Ranks: ReadonlyArray<{ id: string; rank: number; claim: string }>;
    },
    generation: number,
  ): Promise<Set<number>> {
    const ranks = new Set<number>();
    if (instance.phase !== "STOPPING" && instance.phase !== "STARTING") return ranks;
    for (const rank of instance.Ranks) {
      if (rank.claim !== "HELD") continue;
      const latest = await db.instanceStep.findFirst({
        where: { instanceId: instance.id, rank: rank.rank, phase: "STOP", generation },
        orderBy: { sequence: "desc" },
        select: { state: true, intent: true },
      });
      if (
        latest &&
        (latest.state === "FAILED" || latest.state === "CANCELLED") &&
        interactiveIntent(latest.intent)
      )
        ranks.add(rank.rank);
    }
    return ranks;
  }

  /** Whether the drain has anything to do for this instance (read without fences). */
  private async drainWork(db: Tx, instanceId: string): Promise<boolean> {
    if ((await this.waitingInteractiveSteps(db, instanceId)).length > 0) return true;
    const instance = await db.runtimeInstance.findUnique({
      where: { id: instanceId },
      select: { id: true, phase: true, Ranks: { select: { id: true, rank: true, claim: true } } },
    });
    if (!instance) return false;
    const generation = await this.currentGeneration(db, instanceId);
    return (await this.unanswerableStopRanks(db, instance, generation)).size > 0;
  }

  private async drainInstance(tx: Tx, instanceId: string, userId: string) {
    // Again under the owner fence: an owner unbanned meanwhile answers their steps.
    if (await this.ownerActive(tx, userId)) return;
    const instance = await tx.runtimeInstance.findUnique({
      where: { id: instanceId },
      include: INSTANCE_INCLUDE,
    });
    if (!instance) return;
    const now = this.now();
    const generation = await this.currentGeneration(tx, instanceId);
    let startCancelled = false;
    let stopCancelled = false;
    for (const step of await this.waitingInteractiveSteps(tx, instanceId)) {
      // Closed by step id on whichever session holds it; a person's run is left alone.
      const closed =
        step.state === "PENDING"
          ? null
          : this.relay.closeOperatorStep?.(step.id, { keepRunning: true });
      if (closed === "running") continue;
      // A dispatch whose screen never came up gives its attempt back, but only when this close
      // ended it: a terminal the ban fence already cancelled (or another process tracks)
      // answers "absent" and may have run, so its attempt counts. A step that never ran is
      // CANCELLED (proof for the claim's auto-release), else FAILED.
      const attempts =
        step.state === "PENDING"
          ? step.attempts
          : closed === "closed"
            ? attemptsAfterServerClose(step)
            : step.attempts;
      const changed = await tx.instanceStep.updateMany({
        where: { id: step.id, state: step.state, ownerEpoch: step.ownerEpoch },
        data: {
          state: attempts === 0 ? "CANCELLED" : "FAILED",
          errorCode: OWNER_INACTIVE,
          attempts,
          deadline: null,
          leaseExpiresAt: null,
          operatorHold: null,
          operatorTerminalId: null,
        },
      });
      if (changed.count === 0) continue;
      if (step.phase === "STOP") stopCancelled = true;
      // Only this run's start stops the instance; an older run's step is just cancelled.
      else if (isStartPhase(step.phase) && step.generation === generation) startCancelled = true;
    }
    // Ranks of the current run whose stop nobody can answer (just cancelled, or failed or given
    // up earlier): marked stopped (HELD_UNKNOWN) with no person. An older run's stop marks nothing.
    const unanswerable = await this.unanswerableStopRanks(tx, instance, generation);
    let marked = 0;
    for (const rank of instance.Ranks) {
      if (rank.claim !== "HELD" || !unanswerable.has(rank.rank)) continue;
      const changed = await tx.instanceRank.updateMany({
        where: { id: rank.id, claim: "HELD" },
        data: {
          claim: "HELD_UNKNOWN",
          claimChangedAt: now,
          markedStoppedAt: now,
          markedStoppedBy: MARKED_STOPPED_OWNER_INACTIVE,
        },
      });
      marked += changed.count;
    }
    if (!startCancelled && !stopCancelled && marked === 0) return;
    const fresh = await tx.runtimeInstance.findUnique({
      where: { id: instanceId },
      include: INSTANCE_INCLUDE,
    });
    if (!fresh) return;
    if (fresh.phase === "STOPPING") await this.settleStopping(tx, fresh);
    else if (
      fresh.desiredState === "RUNNING" &&
      (LIVE_PHASES as readonly string[]).includes(fresh.phase)
    )
      await this.gangStop(tx, fresh, OWNER_INACTIVE);
    else await this.syncNeedsOperator(tx, instanceId);
  }

  // ── Results ──

  /** Results of one step apply in the order they arrived (frames are not serialized). */
  private readonly resultChains = new Map<string, Promise<void>>();

  /** `runtime.job.result` from the node's current session. */
  handleJobResult(ref: NodeSessionRef, result: JobResult): Promise<void> {
    const previous = this.resultChains.get(result.stepId) ?? Promise.resolve();
    const applied = previous.then(() => this.applyJobResult(ref, result));
    const chained = applied.catch(() => undefined);
    this.resultChains.set(result.stepId, chained);
    void chained.finally(() => {
      if (this.resultChains.get(result.stepId) === chained) this.resultChains.delete(result.stepId);
    });
    return applied;
  }

  private async applyJobResult(ref: NodeSessionRef, result: JobResult): Promise<void> {
    if (result.ownerEpoch !== this.ownerEpoch(ref.connectionGeneration)) return;
    // Progress never extends the absolute deadline.
    if (result.status === "running") return;
    const progress =
      result.status === "awaiting_operator" ||
      result.status === "operator_running" ||
      result.status === "operator_closed";
    const row = await prisma.instanceStep.findFirst({
      where: {
        id: result.stepId,
        instanceId: result.instanceId,
        nodeId: ref.nodeId,
        rank: result.rank,
        intentHash: result.intentHash,
        ownerEpoch: result.ownerEpoch,
        // A final can overtake its own `operator_running` (or follow the screen at once): a
        // waiting interactive step accepts it too.
        state: { in: ["RUNNING", "AWAITING_OPERATOR"] },
        Instance: { userId: ref.userId },
      },
      select: { id: true },
    });
    // A terminal that came up (or runs) for a dispatch that is no longer the step's: nobody can
    // answer it, so it must not hold the node's terminal slots until the session ends.
    const stale = () => {
      if (
        result.terminalId !== undefined &&
        (result.status === "awaiting_operator" || result.status === "operator_running")
      )
        this.relay.closeOperatorTerminal?.(ref.nodeId, result.terminalId);
    };
    if (!row) {
      stale();
      return;
    }
    let dropped = false;
    await this.write(ref.userId, result.instanceId, async (tx) => {
      dropped = false;
      const step = await tx.instanceStep.findUnique({ where: { id: row.id } });
      if (!step || step.ownerEpoch !== result.ownerEpoch) {
        dropped = true;
        return;
      }
      if (step.state !== "RUNNING" && step.state !== "AWAITING_OPERATOR") {
        dropped = true;
        return;
      }
      const interactive = interactiveIntent(step.intent);
      // Only an interactive step has operator progress or waits for a person.
      if (!interactive && (progress || step.state !== "RUNNING")) return;
      // Every result of an interactive job names the terminal of the dispatch it answers: a
      // late answer to an earlier dispatch, or after its terminal closed, settles nothing.
      if (
        interactive &&
        (step.operatorTerminalId === null || result.terminalId !== step.operatorTerminalId)
      ) {
        dropped = true;
        return;
      }
      if (progress) {
        await this.operatorProgress(tx, step, result);
        return;
      }
      // The node cannot hold the terminal (switched off, at its cap): the step waits for its
      // person (closed, reopenable) instead of failing the run or looping.
      if (
        interactive &&
        result.status === "failed" &&
        result.error === "operator_terminals_disabled"
      ) {
        await this.operatorClosed(tx, step, { error: "operator_terminals_disabled" });
        return;
      }
      const stopLike = step.phase === "STOP" || step.phase === "STATUS";
      const succeeded = result.status === "succeeded" && (!stopLike || result.stopped);
      // A stop proof that failed keeps the node's reason (`port_in_use`, ...) as its error
      // code: the stop evidence shows a person why the claim stays held.
      let code = succeeded
        ? null
        : (result.error ??
          (stopLike
            ? (stopProofFailure(step.phase, result.detail) ?? "not_stopped")
            : "job_failed"));
      // A Relay-only node cannot be sent the definition: missing there is frozen (terminal).
      if (
        code === "definition_missing" &&
        isStartPhase(step.phase) &&
        !(await this.nodeFullControl(tx, ref.nodeId))
      )
        code = "definition_frozen";
      // A start that failed only because the definition has not arrived yet is retried after
      // a re-push, without counting an attempt (§3.4 B1).
      // A start the node never admitted because its session went away is simply sent again.
      const retry =
        !succeeded &&
        isStartPhase(step.phase) &&
        (code === "session_disconnected" ||
          (code === "definition_missing" && (await this.nodeFullControl(tx, ref.nodeId))));
      if (retry) {
        await tx.instanceStep.updateMany({
          where: { id: step.id, state: step.state },
          data: {
            state: "PENDING",
            ownerEpoch: null,
            deadline: null,
            leaseExpiresAt: null,
            attempts: { decrement: 1 },
            notBefore: new Date(this.now().getTime() + DEFINITION_RETRY_MS),
            ...NO_OPERATOR,
          },
        });
        if (code === "definition_missing") this.options.resyncDefinitions?.(ref.nodeId);
        if (interactive) await this.syncNeedsOperator(tx, step.instanceId);
        return;
      }
      const changed = await tx.instanceStep.updateMany({
        where: { id: step.id, state: step.state, ownerEpoch: result.ownerEpoch },
        data: {
          state: succeeded ? "SUCCEEDED" : "FAILED",
          errorCode: code,
          deadline: null,
          leaseExpiresAt: null,
          operatorTerminalId: null,
          // A success that overtook its own `operator_running` records the acceptance.
          ...(succeeded && step.state === "AWAITING_OPERATOR" && step.operatorAcceptedAt === null
            ? { operatorAcceptedAt: this.now() }
            : {}),
        },
      });
      if (changed.count === 0) return;
      if (interactive) await this.syncNeedsOperator(tx, step.instanceId);
      await this.afterStep(tx, step, succeeded, code);
    });
    if (dropped) stale();
    this.wake();
  }

  private async nodeFullControl(tx: Tx, nodeId: string): Promise<boolean> {
    const node = await tx.node.findUnique({
      where: { id: nodeId },
      select: { trust: true, trustLowerRequestedAt: true },
    });
    return node?.trust === "FULL" && node.trustLowerRequestedAt === null;
  }

  /** What a finished step means for its instance. */
  private async afterStep(tx: Tx, step: FinishedStep, succeeded: boolean, code: string | null) {
    const { instanceId, phase, rank, generation } = step;
    const instance = await tx.runtimeInstance.findUnique({
      where: { id: instanceId },
      include: INSTANCE_INCLUDE,
    });
    if (!instance) return;
    const now = this.now();
    // Start and health results of an earlier run say nothing about this one.
    if (
      (isStartPhase(phase) || phase === "HEALTH") &&
      generation !== (await this.currentGeneration(tx, instanceId))
    )
      return;
    if (phase === "STOP" || phase === "STATUS") {
      const claim = instance.Ranks.find((row) => row.rank === rank);
      // This step is the leading stop of the run now starting (proof the previous run ended).
      const leading =
        phase === "STOP" &&
        step.sequence === generation * GENERATION_STRIDE &&
        generation === (await this.currentGeneration(tx, instanceId)) &&
        instance.phase === "STARTING";
      const current = generation === (await this.currentGeneration(tx, instanceId));
      if (succeeded && claim) {
        // The leading stop of a restart proves the previous run ended; the claim stays (the
        // new run uses it). Any other verified stop of this run releases it, and a probe
        // releases a claim marked stopped. A late answer of an earlier run releases nothing.
        const proves =
          phase === "STATUS"
            ? statusProbeWanted(
                instance,
                claim.claim,
                generation,
                await this.currentGeneration(tx, instanceId),
              )
            : current && (!leading || claim.claim === "HELD_UNKNOWN");
        if (proves) await this.release(tx, claim.id, now);
      } else if (!succeeded && leading) {
        // The previous run could not be proven stopped: the new run must not start over it.
        await this.gangStop(tx, instance, "startup_failed");
        return;
      }
      if (instance.phase === "STOPPING") await this.settleStopping(tx, instance);
      return;
    }
    if (phase === "HEALTH") {
      await this.recordHealth(tx, instance, succeeded);
      return;
    }
    // Start phases.
    if (instance.phase !== "STARTING" || instance.desiredState !== "RUNNING") return;
    if (!succeeded) {
      // A start an agent may not run here, or a version the Relay-only node does not hold,
      // fails the same way every time: no automatic restart.
      const terminal = code !== null && TERMINAL_START_ERRORS.has(code);
      await this.gangStop(
        tx,
        instance,
        terminal
          ? (code ?? "startup_failed")
          : phase === "READINESS"
            ? "readiness_timeout"
            : "startup_failed",
      );
      return;
    }
    if (phase !== "READINESS") return;
    const gen = generation;
    const unfinished = await tx.instanceStep.count({
      where: {
        instanceId,
        generation: gen,
        phase: { in: [...START_PHASES] },
        state: { not: "SUCCEEDED" },
      },
    });
    if (unfinished > 0) return;
    await tx.runtimeInstance.update({
      where: { id: instanceId },
      data: {
        phase: "READY",
        phaseReason: null,
        phaseChangedAt: now,
        lastHealthAt: now,
        healthFailures: 0,
        healthSuccesses: 0,
        unhealthySince: null,
        unavailableSince: null,
        needsOperator: null,
        needsOperatorSince: null,
      },
    });
    await registerExecutionTargets(tx, instance);
  }

  private async recordHealth(tx: Tx, instance: InstanceRow, success: boolean) {
    const launch = launchOf(instance);
    if (!launch || (instance.phase !== "READY" && instance.phase !== "UNHEALTHY")) return;
    const now = this.now();
    const failures = success ? 0 : instance.healthFailures + 1;
    const successes = success ? instance.healthSuccesses + 1 : 0;
    let phase = instance.phase;
    if (phase === "READY" && failures >= launch.health.failureThreshold) phase = "UNHEALTHY";
    if (phase === "UNHEALTHY" && successes >= launch.health.successThreshold) phase = "READY";
    await tx.runtimeInstance.update({
      where: { id: instance.id },
      data: {
        healthFailures: failures,
        healthSuccesses: successes,
        lastHealthAt: now,
        ...(phase !== instance.phase
          ? {
              phase,
              phaseChangedAt: now,
              phaseReason: phase === "UNHEALTHY" ? "health_failed" : null,
              unhealthySince: phase === "UNHEALTHY" ? now : null,
            }
          : {}),
      },
    });
  }

  // ── Held-unknown probes ──

  /**
   * Ranks marked stopped are probed with a status step every 5 minutes while the node is online,
   * whatever the instance's phase (a STOPPED instance's hold is proven and released the same
   * way). Only ranks on connected nodes are read, so ranks on offline nodes never crowd them out.
   */
  private async probeHeldUnknown() {
    const online = this.relay.onlineNodeIds?.();
    if (online && online.length === 0) return;
    const ranks = await prisma.instanceRank.findMany({
      where: { claim: "HELD_UNKNOWN", nodeId: online ? { in: online } : { not: null } },
      select: {
        id: true,
        nodeId: true,
        rank: true,
        instanceId: true,
        Instance: { select: { userId: true } },
      },
      take: BATCH,
    });
    for (const rank of ranks) {
      if (!rank.nodeId || !this.relay.nodeSession(rank.nodeId)) continue;
      await this.write(rank.Instance.userId, rank.instanceId, async (tx) => {
        const recent = await tx.instanceStep.count({
          where: {
            instanceId: rank.instanceId,
            rank: rank.rank,
            phase: "STATUS",
            OR: [
              { state: { in: [...LIVE_STEP_STATES] } },
              { updatedAt: { gt: new Date(this.now().getTime() - HELD_UNKNOWN_PROBE_MS) } },
            ],
          },
        });
        if (recent > 0) return;
        const instance = await tx.runtimeInstance.findUnique({
          where: { id: rank.instanceId },
          include: INSTANCE_INCLUDE,
        });
        const launch = instance ? launchOf(instance) : null;
        const row = instance?.Ranks.find((candidate) => candidate.id === rank.id);
        if (!instance || !launch || !row) return;
        const generation = Math.max(await this.currentGeneration(tx, instance.id), 1);
        const attempts = await this.nextStatusAttempt(tx, instance.id, row.rank);
        await this.insertSteps(tx, instance, [
          stopStep({
            instance: instanceInput(instance),
            rank: rankInput(row),
            nnodes: instance.Ranks.length,
            launch,
            generation,
            attempt: attempts,
            operationId: null,
            phase: "STATUS",
          }),
        ]);
      }).catch((error: unknown) =>
        console.error("[lifecycle] probing a rank marked stopped failed", errorName(error)),
      );
    }
  }

  // ── Sessions ──

  /**
   * A node (re)connected: steps still RUNNING under an earlier session or an earlier server
   * process were never answered there; they go back to PENDING (the node re-observes them).
   */
  async requeueStale(ref: NodeSessionRef): Promise<void> {
    const current = this.ownerEpoch(ref.connectionGeneration);
    await this.requeueLost(ref, { NOT: { ownerEpoch: current } }, "re-queuing a stale step");
  }

  /** The session ended: its RUNNING steps go back to PENDING (the node re-observes them). */
  async nodeDisconnected(ref: NodeSessionRef): Promise<void> {
    const ownerEpoch = this.ownerEpoch(ref.connectionGeneration);
    await this.requeueLost(ref, { ownerEpoch }, "releasing a lost lease");
  }

  /**
   * Steps a lost session held go back to PENDING: RUNNING ones, and interactive steps whose
   * terminal died with the session (AWAITING_OPERATOR with a terminal; a closed one keeps
   * waiting for its person to reopen it). An interactive step is reissued with a fresh
   * terminal; its dispatch counts only if a person's run had started.
   */
  private async requeueLost(
    ref: NodeSessionRef,
    epoch: Prisma.InstanceStepWhereInput,
    what: string,
  ): Promise<void> {
    const rows = await prisma.instanceStep.findMany({
      where: {
        nodeId: ref.nodeId,
        ...epoch,
        OR: [
          { state: "RUNNING" },
          { state: "AWAITING_OPERATOR", operatorTerminalId: { not: null } },
        ],
      },
      select: { id: true, instanceId: true },
    });
    for (const row of rows)
      await this.write(ref.userId, row.instanceId, async (tx) => {
        const step = await tx.instanceStep.findFirst({ where: { id: row.id, ...epoch } });
        if (!step) return;
        if (interactiveIntent(step.intent)) {
          if (step.state === "RUNNING" || step.operatorTerminalId !== null)
            await this.reissueOperatorStep(tx, step);
          return;
        }
        if (step.state !== "RUNNING") return;
        await tx.instanceStep.updateMany({
          where: { id: step.id, state: "RUNNING", ownerEpoch: step.ownerEpoch },
          data: { state: "PENDING", ownerEpoch: null, deadline: null, leaseExpiresAt: null },
        });
      }).catch((error: unknown) => console.error(`[lifecycle] ${what} failed`, errorName(error)));
    this.wake();
  }

  /**
   * A complete inventory: ranks the node reports `stopped` are proven stopped (claims released
   * while STOPPING); a live run's rank the node reports stopped or unknown has crashed (gang
   * stop, then the restart rule). Always-on instances follow their runtime's status.
   */
  async runtimeInventory(
    ref: NodeSessionRef,
    snapshot: RuntimeInventorySnapshot,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const ranks = await prisma.instanceRank.findMany({
      where: {
        nodeId: ref.nodeId,
        claim: { in: ["HELD", "HELD_UNKNOWN"] },
        Instance: { userId: ref.userId },
      },
      select: { id: true, rank: true, instanceId: true },
    });
    const reported = new Map(
      snapshot.instances.map((record) => [`${record.instanceId}:${record.rank}`, record]),
    );
    for (const rank of ranks) {
      const record = reported.get(`${rank.instanceId}:${rank.rank}`);
      await this.write(ref.userId, rank.instanceId, async (tx) => {
        const instance = await tx.runtimeInstance.findUnique({
          where: { id: rank.instanceId },
          include: INSTANCE_INCLUDE,
        });
        const claim = instance?.Ranks.find((row) => row.id === rank.id);
        if (!instance || !claim || claim.nodeId !== ref.nodeId) return;
        // A start of this rank in flight may have crossed the snapshot: no proof then.
        const inFlight = await tx.instanceStep.count({
          where: {
            instanceId: instance.id,
            rank: claim.rank,
            generation: await this.currentGeneration(tx, instance.id),
            phase: { in: [...START_PHASES] },
            attempts: { gt: 0 },
            OR: [
              { state: { in: ["RUNNING", "PENDING", "AWAITING_OPERATOR"] } },
              { errorCode: "stopped" },
            ],
          },
        });
        if (record?.phase === "stopped" && inFlight === 0) {
          if (instance.phase === "STOPPING" || claim.claim === "HELD_UNKNOWN") {
            await this.release(tx, claim.id, this.now());
            if (instance.phase === "STOPPING") await this.settleStopping(tx, instance);
            return;
          }
        }
        // A ready run whose rank the node no longer runs has crashed: gang stop, then the
        // restart rule. A record of another launch version is an older run (ignored).
        const live =
          (instance.phase === "READY" || instance.phase === "UNHEALTHY") &&
          instance.desiredState === "RUNNING";
        const sameRun = !record || record.launchVersionId === instance.launchVersionId;
        const lost = !record || record.phase === "stopped" || record.phase === "unknown";
        if (live && sameRun && lost && claim.claim === "HELD") {
          await this.gangStop(tx, instance, "crashed");
          return;
        }
        if (record && claim.claim === "HELD" && instance.desiredState === "RUNNING")
          await this.recordInstanceFacts(tx, instance, record);
      }).catch((error: unknown) =>
        console.error("[lifecycle] applying inventory failed", errorName(error)),
      );
    }
    await applyAlwaysOnInventory(ref, snapshot.alwaysOn, this.now()).catch((error: unknown) =>
      console.error("[lifecycle] applying always-on inventory failed", errorName(error)),
    );
    this.wake();
    return { ok: true };
  }

  /** The head rank's engine facts of the run the node reports (admission reads them). */
  private async recordInstanceFacts(tx: Tx, instance: InstanceRow, record: InstanceRecord) {
    if (record.rank !== 0 || record.launchVersionId !== instance.launchVersionId) return;
    if (record.phase !== "ready" && record.phase !== "unhealthy" && record.phase !== "starting")
      return;
    const facts = storedInstanceFacts(record.engineFacts);
    if (!facts || sameStoredInstanceFacts(facts, instanceStoredFacts(instance))) return;
    await tx.runtimeInstance.update({
      where: { id: instance.id },
      data: { ...facts, factsAt: this.now() },
    });
  }

  handlers(): Pick<
    NodeFrameHandlers,
    "runtime.job.result" | "nodeDisconnected" | "nodeReady" | "runtimeInventory"
  > {
    return {
      "runtime.job.result": (ref, frame) => this.handleJobResult(ref, frame),
      nodeDisconnected: (ref) => void this.nodeDisconnected(ref),
      nodeReady: (ref) => this.requeueStale(ref),
      runtimeInventory: (ref, snapshot) => this.runtimeInventory(ref, snapshot),
    };
  }
}

/** A READY instance serves its runtime's models: one execution target per served model. */
export async function registerExecutionTargets(
  tx: Tx,
  instance: { id: string; userId: string; runtimeId: string },
): Promise<void> {
  const models = await tx.runtimeModel.findMany({
    where: { runtimeId: instance.runtimeId, userId: instance.userId },
    select: { id: true },
  });
  if (models.length === 0) return;
  await tx.executionTarget.createMany({
    data: models.map((model) => ({
      userId: instance.userId,
      kind: "INSTANCE_MODEL" as const,
      instanceId: instance.id,
      runtimeModelId: model.id,
    })),
    skipDuplicates: true,
  });
}

export type { StepIntent };
