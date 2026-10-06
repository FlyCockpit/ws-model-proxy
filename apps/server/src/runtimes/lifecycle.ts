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
 * Not here yet (later chunks): operator terminals for interactive steps (the 0.4.0 node
 * answers `interactive_unsupported` until both sides have them: such a start FAILS, such a stop
 * needs Forget), node-origin always-on runtimes from inventory.
 */
import { randomBytes } from "node:crypto";
import { graphWrite, instanceCapacityFences } from "@ws-model-proxy/api/lib/graph-write";
import { type RuntimeLaunch, runtimeLaunchSchema } from "@ws-model-proxy/api/lib/runtime-spec";
import { RUNTIME_ADVANCED } from "@ws-model-proxy/config/runtime-defaults";
import prisma, { type Prisma } from "@ws-model-proxy/db";
import {
  type NodeToServerControlFrame,
  type NodeTrustWire,
  RUNTIME_JOB_PRE_ADMISSION_ERRORS,
  type ServerToNodeControlFrame,
} from "../relay/frames.js";
import type {
  NodeFrameHandlers,
  NodeSessionRef,
  RuntimeInventorySnapshot,
  SendGuard,
} from "../relay/session-manager.js";
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
/** A STOPPING rank whose node has been offline this long needs a person (Forget). */
export const FORGET_AFTER_OFFLINE_MS = 10 * 60_000;
/** Held-unknown ranks are probed this often while their node is online. */
export const HELD_UNKNOWN_PROBE_MS = 5 * 60_000;
/** Completed health probes are kept this long. */
const HEALTH_HISTORY_MS = 60 * 60_000;
const DEFINITION_RETRY_MS = 5_000;
const RESTART_BACKOFF_BASE_MS = 10_000;
const RESTART_BACKOFF_MAX_MS = 5 * 60_000;
const RETAKE_RETRY_MS = 30_000;

/** Codes that prove a stop cannot be proven by the node: a person decides (Forget). */
const UNPROVABLE_STOP = new Set([
  "definition_missing",
  "definition_frozen",
  "instance_unknown",
  "owned_launch_unconfirmed",
  "launch_unconfirmed",
]);
const PRE_ADMISSION: ReadonlySet<string> = new Set(RUNTIME_JOB_PRE_ADMISSION_ERRORS);

export type LifecycleRelay = {
  sendToNode(nodeId: string, frame: ServerToNodeControlFrame, guard?: SendGuard): boolean;
  nodeSession(nodeId: string): { connectionGeneration: number; trust: NodeTrustWire } | null;
  /** Nodes with a live session here (dispatch looks at their steps only). */
  onlineNodeIds?(): string[];
};

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
  // No operator terminals on this node (or in this release): a person must run it.
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
    LaunchVersion: { select: { spec: true; launchHash: true; advanced: true } };
  };
}>;

const INSTANCE_INCLUDE = {
  Ranks: true,
  LaunchVersion: { select: { spec: true, launchHash: true, advanced: true } },
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
   * and settle STOPPED once every claim is released (or forgotten).
   */
  private async settleStopping(tx: Tx, instance: InstanceRow) {
    const now = this.now();
    const generation = await this.currentGeneration(tx, instance.id);
    // Pending start-phase and health steps never run now. Never-sent ones are CANCELLED (proof
    // they never ran); a re-queued one (attempts > 0) may have run and is FAILED.
    await tx.instanceStep.updateMany({
      where: {
        instanceId: instance.id,
        state: "PENDING",
        phase: { in: [...START_PHASES, "HEALTH"] },
        attempts: 0,
      },
      data: { state: "CANCELLED" },
    });
    await tx.instanceStep.updateMany({
      where: {
        instanceId: instance.id,
        state: "PENDING",
        phase: { in: [...START_PHASES, "HEALTH"] },
      },
      data: { state: "FAILED", errorCode: "stopped" },
    });
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
    let needsForget = false;
    // Claims as they are now (a caller's copy may predate a release in this transaction).
    const current = await tx.instanceRank.findMany({ where: { instanceId: instance.id } });
    for (const rank of current) {
      if (rank.claim !== "HELD") continue;
      const mine = steps.filter((step) => step.rank === rank.rank);
      const starts = mine.filter((step) => step.phase !== "STOP" && step.phase !== "STATUS");
      const leadingStop = mine.find(
        (step) => step.phase === "STOP" && step.sequence === generation * GENERATION_STRIDE,
      );
      const neverRan = starts.every(
        (step) =>
          step.state === "CANCELLED" ||
          (step.state === "PENDING" && step.attempts === 0) ||
          (step.state === "FAILED" && PRE_ADMISSION.has(step.errorCode ?? "")),
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
      // Forget), whether or not a stop is still queued for it.
      if (
        rank.nodeId !== null &&
        (await this.offlineSince(tx, rank.nodeId, FORGET_AFTER_OFFLINE_MS))
      )
        needsForget = true;
      if (stops.some((step) => (LIVE_STEP_STATES as readonly string[]).includes(step.state)))
        continue;
      const failed = stops.filter((step) => step.state === "FAILED");
      if (
        failed.some((step) => UNPROVABLE_STOP.has(step.errorCode ?? "")) ||
        failed.length >= STOP_ATTEMPTS ||
        !launch ||
        rank.nodeId === null
      ) {
        needsForget = true;
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
    // A step waiting for a person keeps its need (operator chunk); otherwise FORGET or none.
    const need = needsForget ? "FORGET" : instance.needsOperator === "STEP" ? "STEP" : null;
    if (instance.needsOperator !== need)
      await tx.runtimeInstance.update({
        where: { id: instance.id },
        data: { needsOperator: need, needsOperatorSince: need ? now : null },
      });
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

  /** Every claim is released or forgotten: STOPPED, then the restart rule for RUNNING. */
  private async settleStopped(tx: Tx, instance: InstanceRow, now: Date) {
    // Nothing is left to stop: pending stops are not needed any more (re-queued ones fail).
    await tx.instanceStep.updateMany({
      where: { instanceId: instance.id, phase: "STOP", state: "PENDING", attempts: 0 },
      data: { state: "CANCELLED" },
    });
    await tx.instanceStep.updateMany({
      where: { instanceId: instance.id, phase: "STOP", state: "PENDING" },
      data: { state: "FAILED", errorCode: "superseded" },
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
      where: { desiredState: "RUNNING", phase: "STOPPED", nextRestartAt: { lte: this.now() } },
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
        forgottenAt: null,
        forgottenBy: null,
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
    const rows = await prisma.instanceStep.findMany({
      where: { state: "RUNNING", deadline: { lte: this.now() } },
      select: { id: true, instanceId: true, Instance: { select: { userId: true } } },
      take: BATCH,
    });
    for (const row of rows) {
      await this.write(row.Instance.userId, row.instanceId, async (tx) => {
        const step = await tx.instanceStep.findUnique({ where: { id: row.id } });
        if (step?.state !== "RUNNING" || !step.deadline || step.deadline > this.now()) return;
        const intent = stepIntentSchema.safeParse(step.intent);
        // A person's run is never cut off (operator terminals, later chunk).
        if (intent.success && intent.data.interactive && step.operatorAcceptedAt) return;
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
        OR: [{ notBefore: null }, { notBefore: { lte: this.now() } }],
        // Steps that can go now: on a connected node.
        ...(online ? { nodeId: { in: online } } : {}),
      },
      select: { id: true, nodeId: true, instanceId: true, Instance: { select: { userId: true } } },
      orderBy: [{ sequence: "asc" }, { createdAt: "asc" }],
      take: BATCH * 4,
    });
    for (const row of rows) {
      const session = this.relay.nodeSession(row.nodeId);
      if (!session) continue;
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
      });
      if (!sent) await this.undeliver(row.Instance.userId, row.instanceId, row.id, job.ownerEpoch);
    }
  }

  /** Checks a PENDING step may run now and claims it (RUNNING, lease, attempt). */
  private async claimStep(
    tx: Tx,
    stepId: string,
    session: { connectionGeneration: number; trust: NodeTrustWire },
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
      // A stop of an earlier run, or a probe of a claim that is no longer forgotten, would act
      // on the run that holds the claim now: it never goes out.
      const superseded =
        (step.phase === "STOP" &&
          step.generation < (await this.currentGeneration(tx, instance.id))) ||
        (step.phase === "STATUS" && claim !== "HELD_UNKNOWN");
      if (claim === "RELEASED" || superseded) {
        await tx.instanceStep.updateMany({
          where: { id: step.id, state: "PENDING" },
          data:
            step.attempts === 0
              ? { state: "CANCELLED" }
              : { state: "FAILED", errorCode: "released" },
        });
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
              ? { state: "CANCELLED" }
              : { state: "FAILED", errorCode: "superseded" },
        });
        return null;
      }
      if (instance.desiredState !== "RUNNING") return null;
      if (startPhase && instance.phase !== "STARTING") return null;
      if (step.phase === "HEALTH" && instance.phase !== "READY" && instance.phase !== "UNHEALTHY")
        return null;
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
    if (!node || node.userId !== instance.userId) return null;
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
    const deadline = new Date(now.getTime() + intent.data.timeoutMs);
    const claimed = await tx.instanceStep.updateMany({
      where: { id: step.id, state: "PENDING" },
      data: {
        state: "RUNNING",
        ownerEpoch,
        attempts: { increment: 1 },
        deadline,
        leaseExpiresAt: deadline,
        notBefore: null,
      },
    });
    if (claimed.count === 0) return null;
    return jobFrame({
      stepId: step.id,
      instanceId: instance.id,
      phase: step.phase,
      generation: step.generation,
      intent: intent.data,
      intentHash: step.intentHash,
      ownerEpoch,
      headAddr,
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
        },
      }),
    ).catch((error: unknown) =>
      console.error("[lifecycle] returning an undelivered step failed", errorName(error)),
    );
  }

  private async failStep(tx: Tx, stepId: string, code: string) {
    await tx.instanceStep.updateMany({
      where: { id: stepId, state: { in: ["PENDING", "RUNNING"] } },
      data: { state: "FAILED", errorCode: code, deadline: null, leaseExpiresAt: null },
    });
  }

  // ── Results ──

  /** `runtime.job.result` from the node's current session. */
  async handleJobResult(ref: NodeSessionRef, result: JobResult): Promise<void> {
    if (result.ownerEpoch !== this.ownerEpoch(ref.connectionGeneration)) return;
    // Operator progress belongs to the operator chunk.
    if (result.status !== "succeeded" && result.status !== "failed") return;
    const row = await prisma.instanceStep.findFirst({
      where: {
        id: result.stepId,
        instanceId: result.instanceId,
        nodeId: ref.nodeId,
        rank: result.rank,
        intentHash: result.intentHash,
        ownerEpoch: result.ownerEpoch,
        state: "RUNNING",
        Instance: { userId: ref.userId },
      },
      select: { id: true },
    });
    if (!row) return;
    await this.write(ref.userId, result.instanceId, async (tx) => {
      const step = await tx.instanceStep.findUnique({ where: { id: row.id } });
      if (step?.state !== "RUNNING" || step.ownerEpoch !== result.ownerEpoch) return;
      const stopLike = step.phase === "STOP" || step.phase === "STATUS";
      const succeeded = result.status === "succeeded" && (!stopLike || result.stopped);
      let code = succeeded ? null : (result.error ?? (stopLike ? "not_stopped" : "job_failed"));
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
          where: { id: step.id, state: "RUNNING" },
          data: {
            state: "PENDING",
            ownerEpoch: null,
            deadline: null,
            leaseExpiresAt: null,
            attempts: { decrement: 1 },
            notBefore: new Date(this.now().getTime() + DEFINITION_RETRY_MS),
          },
        });
        if (code === "definition_missing") this.options.resyncDefinitions?.(ref.nodeId);
        return;
      }
      const changed = await tx.instanceStep.updateMany({
        where: { id: step.id, state: "RUNNING", ownerEpoch: result.ownerEpoch },
        data: {
          state: succeeded ? "SUCCEEDED" : "FAILED",
          errorCode: code,
          deadline: null,
          leaseExpiresAt: null,
        },
      });
      if (changed.count === 0) return;
      await this.afterStep(tx, step, succeeded, code);
    });
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
        // releases a forgotten claim. A late answer of an earlier run releases nothing.
        const proves =
          phase === "STATUS"
            ? claim.claim === "HELD_UNKNOWN"
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

  /** Forgotten ranks are probed with a status step every 5 minutes while the node is online. */
  private async probeHeldUnknown() {
    const ranks = await prisma.instanceRank.findMany({
      where: { claim: "HELD_UNKNOWN", nodeId: { not: null } },
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
        const attempts = await tx.instanceStep.count({
          where: { instanceId: instance.id, rank: row.rank, generation, phase: "STATUS" },
        });
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
        console.error("[lifecycle] probing a forgotten rank failed", errorName(error)),
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
    const rows = await prisma.instanceStep.findMany({
      where: { nodeId: ref.nodeId, state: "RUNNING", NOT: { ownerEpoch: current } },
      select: { id: true, instanceId: true, ownerEpoch: true },
    });
    for (const row of rows)
      await this.write(ref.userId, row.instanceId, (tx) =>
        tx.instanceStep.updateMany({
          where: { id: row.id, state: "RUNNING", ownerEpoch: row.ownerEpoch },
          data: { state: "PENDING", ownerEpoch: null, deadline: null, leaseExpiresAt: null },
        }),
      ).catch((error: unknown) =>
        console.error("[lifecycle] re-queuing a stale step failed", errorName(error)),
      );
    this.wake();
  }

  /** The session ended: its RUNNING steps go back to PENDING (the node re-observes them). */
  async nodeDisconnected(ref: NodeSessionRef): Promise<void> {
    const ownerEpoch = this.ownerEpoch(ref.connectionGeneration);
    const rows = await prisma.instanceStep.findMany({
      where: { nodeId: ref.nodeId, state: "RUNNING", ownerEpoch },
      select: { id: true, instanceId: true },
    });
    for (const row of rows)
      await this.write(ref.userId, row.instanceId, (tx) =>
        tx.instanceStep.updateMany({
          where: { id: row.id, state: "RUNNING", ownerEpoch },
          data: { state: "PENDING", ownerEpoch: null, deadline: null, leaseExpiresAt: null },
        }),
      ).catch((error: unknown) =>
        console.error("[lifecycle] releasing a lost lease failed", errorName(error)),
      );
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
            OR: [{ state: { in: ["RUNNING", "PENDING"] } }, { errorCode: "stopped" }],
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
        if (live && sameRun && lost && claim.claim === "HELD")
          await this.gangStop(tx, instance, "crashed");
      }).catch((error: unknown) =>
        console.error("[lifecycle] applying inventory failed", errorName(error)),
      );
    }
    await this.applyAlwaysOn(ref, snapshot);
    this.wake();
    return { ok: true };
  }

  private async applyAlwaysOn(ref: NodeSessionRef, snapshot: RuntimeInventorySnapshot) {
    const now = this.now();
    for (const entry of snapshot.alwaysOn) {
      if (entry.origin !== "server" || !entry.runtimeId) continue;
      const phase =
        entry.status === "online"
          ? "READY"
          : entry.status === "degraded"
            ? "UNHEALTHY"
            : "UNAVAILABLE";
      // Status columns only (no fence): the instance of the node's own always-on runtime.
      await prisma.runtimeInstance
        .updateMany({
          where: {
            runtimeId: entry.runtimeId,
            userId: ref.userId,
            desiredState: null,
            Runtime: { nodeId: ref.nodeId, kind: "ALWAYS_ON" },
            phase: { not: phase },
          },
          data: {
            phase,
            phaseChangedAt: now,
            phaseReason: phase === "READY" ? null : `node_${entry.status}`,
          },
        })
        .catch((error: unknown) =>
          console.error("[lifecycle] always-on status failed", errorName(error)),
        );
    }
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
