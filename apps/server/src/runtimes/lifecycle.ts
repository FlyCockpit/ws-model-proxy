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
import { canonicalJson } from "@ws-model-proxy/api/lib/canonical-json";
import { releaseClaim, sweepReleaseRequests } from "@ws-model-proxy/api/lib/claim-release";
import { sameStoredInstanceFacts, storedInstanceFacts } from "@ws-model-proxy/api/lib/engine-facts";
import { graphWrite, instanceCapacityFences } from "@ws-model-proxy/api/lib/graph-write";
import {
  fresh,
  isLeadingStop,
  mayHaveRunAfterRequeue,
  owned,
  peekRun,
  physicalLaunch,
  resolveRun,
} from "@ws-model-proxy/api/lib/instance-run";
import {
  CURRENT_RESERVATION_WHERE,
  dropSupersededHolds,
  HOLDING_RESERVATION_WHERE,
  retakeInstanceClaims,
} from "@ws-model-proxy/api/lib/reservations";
import { planRetake } from "@ws-model-proxy/api/lib/retake-plan";
import { type RuntimeLaunch, runtimeLaunchSchema } from "@ws-model-proxy/api/lib/runtime-spec";
import {
  claimGpuIds,
  type StepReservation,
  stepJobReservations,
} from "@ws-model-proxy/api/lib/step-intent";
import { effectiveTrust } from "@ws-model-proxy/api/nodes/trust";
import { healthFailureDetail } from "@ws-model-proxy/config/health-reasons";
import { RUNTIME_ADVANCED } from "@ws-model-proxy/config/runtime-defaults";
import prisma, { type Prisma } from "@ws-model-proxy/db";
import { userCredentialAccessBlocked } from "@ws-model-proxy/db/user-deletion-access";
import {
  type InstanceRecord,
  type NodeToServerControlFrame,
  type NodeTrustWire,
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
  type Physical,
  type RankInput,
  START_PHASES,
  STATUS_SEQUENCE_BASE,
  STOP_ORDER_BASE,
  type StepIntent,
  type StepPhase,
  stepIntentSchema,
  stopStep,
} from "./steps.js";
import { byKey, SweepCursor } from "./sweep.js";

type Tx = Prisma.TransactionClient;
type JobResult = Extract<NodeToServerControlFrame, { type: "runtime.job.result" }>;

const TICK_MS = 1_000;
const BATCH = 64;
const LIVE_STEP_STATES = ["PENDING", "RUNNING", "AWAITING_OPERATOR"] as const;
const LIVE_PHASES = ["STARTING", "READY", "UNHEALTHY", "UNAVAILABLE"] as const;
const ALL_STEP_PHASES: readonly StepPhase[] = [...START_PHASES, "STOP", "STATUS"];
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

/**
 * A start whose run has reservations, on a node whose CLI cannot read them (from before
 * `features.jobReservations`): refused before it is sent, the instance FAILS until the CLI is
 * upgraded (`TERMINAL_START_ERRORS`).
 */
export const CLI_UPGRADE_REQUIRED = "cli_upgrade_required";

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

export type LifecycleRelay = {
  sendToNode(nodeId: string, frame: ServerToNodeControlFrame, guard?: SendGuard): boolean;
  nodeSession(nodeId: string): {
    /** The node's owner (the live session's user). */
    userId: string;
    connectionGeneration: number;
    trust: NodeTrustWire;
    /** The node can hold operator terminals (feature and terminal key). */
    operatorTerminals?: boolean;
    /** The node's CLI reads a job's `reservations` (hello `features.jobReservations`). */
    jobReservations?: boolean;
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

/**
 * A person's accepted interactive run past its timeout, of any run: it is never cut off, its
 * person is asked to look at it (`needsOperator` STEP, needsYou), and the deadline sweep skips
 * it once that need is raised.
 */
function overdueAcceptedRun(now: Date): Prisma.InstanceStepWhereInput {
  return { state: "RUNNING", operatorAcceptedAt: { not: null }, deadline: { lte: now } };
}

/** A step as `afterStep` needs it. */
type FinishedStep = {
  /** A stop proof names its step: `releaseClaim` checks it belongs to the claim's run. */
  id: string;
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
  // A `process` start that hands its server off does so every time: it needs a `service` spec.
  "process_detached",
  // The node's CLI cannot read the job's reservations until it is upgraded.
  CLI_UPGRADE_REQUIRED,
]);

export type LifecycleOptions = {
  /** A start step failed `definition_missing` at Full control: push the node's definitions. */
  resyncDefinitions?: (nodeId: string) => void;
  now?: () => Date;
};

type InstanceRow = Prisma.RuntimeInstanceGetPayload<{
  include: {
    Ranks: true;
    Reservations: {
      where: { supersededGeneration: null };
      select: {
        index: true;
        nodeId: true;
        resources: true;
        Node: { select: { id: true; slug: true; trust: true; trustLowerRequestedAt: true } };
      };
    };
    LaunchVersion: { select: { spec: true; launchHash: true; advanced: true; editor: true } };
  };
}>;

/**
 * `Reservations` (`launch.reservations`, the current plan's) are read only for their nodes: an
 * offline or deleted reservation node makes the instance UNAVAILABLE like a rank's, a queued
 * start waits for what blockers hold there, and an automatic restart places them again. Nothing
 * is ever dispatched to them, and their claim is the ranks' (`lib/reservations.ts`), so no
 * release path here writes them. Rows a restart superseded go once a START of a later
 * generation is claimed (`dropSupersededHolds`).
 */
const INSTANCE_INCLUDE = {
  Ranks: true,
  Reservations: {
    where: CURRENT_RESERVATION_WHERE,
    // Their node's slug goes into the run's steps (`stepReservations`); its trust is checked
    // before an agent's start (`claimStep`).
    select: {
      index: true,
      nodeId: true,
      // The worker GPUs placement recorded (`resources.gpus`) go to the launcher too.
      resources: true,
      Node: { select: { id: true, slug: true, trust: true, trustLowerRequestedAt: true } },
    },
  },
  LaunchVersion: { select: { spec: true, launchHash: true, advanced: true, editor: true } },
} as const;

/** Rows read without the include (older callers' fixtures) have none. */
function reservationsOf(instance: InstanceRow): InstanceRow["Reservations"] {
  return instance.Reservations ?? [];
}

/**
 * The run's reservation nodes (and the worker GPUs each was given) as its steps carry them
 * (single-node instances only; a row whose node was deleted is left out: the instance is stopping or waits to be placed again).
 */
function stepReservations(instance: InstanceRow): StepReservation[] {
  if (instance.Ranks.length !== 1) return [];
  return reservationsOf(instance).flatMap((row) => {
    if (!row.nodeId || !row.Node) return [];
    // The GPUs placement accounted to it on the worker (absent: none recorded).
    const gpuIds = claimGpuIds(row.resources);
    return [
      { index: row.index, nodeId: row.nodeId, node: row.Node.slug, ...(gpuIds ? { gpuIds } : {}) },
    ];
  });
}

/**
 * An automatic restart's reason while it waits for the planner (STOPPED, retried every
 * RETAKE_RETRY_MS): `waiting_` and the refusal's reason (contracts/refusals.ts).
 */
function waitingReason(reason: string): string {
  return `waiting_${reason}`;
}

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
 * stopping (its stops could not prove the stop). Anything else is a run in progress: a probe never
 * goes out for it. (A probe of an earlier run never goes out at all: `claimStep`'s run gate.)
 */
function statusProbeWanted(instance: { phase: string }, claim: string | undefined): boolean {
  return claim === "HELD_UNKNOWN" || (claim === "HELD" && instance.phase === "STOPPING");
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
  /** Each batched sweep's page cursor (`./sweep.ts`): every matching row is reached. */
  private readonly sweeps = {
    prepare: new SweepCursor(BATCH * 4),
    watch: new SweepCursor(BATCH * 4),
    expire: new SweepCursor(BATCH),
    dispatch: new SweepCursor(BATCH * 4),
    drain: new SweepCursor(BATCH),
    restart: new SweepCursor(BATCH),
    prune: new SweepCursor(BATCH * 4),
  };

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
    await this.sweepReleaseRequests();
  }

  /** Release requests past their expiry, or whose hold already ended, are settled. */
  private async sweepReleaseRequests() {
    await sweepReleaseRequests(prisma, this.now()).catch((error: unknown) =>
      console.error("[lifecycle] sweeping release requests failed", errorName(error)),
    );
  }

  // ── Starts ──

  /**
   * STARTING instances whose run has no start steps yet get them (generation = the run). A
   * restart began its run when it was committed (`beginRun`), so this only publishes the steps:
   * nothing here decides which run is current.
   */
  private async prepareStarts() {
    // Prepared runs waiting for their person stay STARTING: the cursor reaches the rest.
    const page = await this.sweeps.prepare.next((page) =>
      prisma.runtimeInstance.findMany({
        where: { ...page.where, desiredState: "RUNNING", phase: "STARTING" },
        select: { id: true, userId: true, phaseChangedAt: true },
        orderBy: page.orderBy,
        take: page.take,
      }),
    );
    for (const row of byKey(page, (row) => row.phaseChangedAt.getTime())) {
      // Plain read first (a legacy row's run computed without writing it).
      if (await this.runPrepared(prisma, row.id, await peekRun(prisma, row.id))) continue;
      await this.write(row.userId, row.id, async (tx) => {
        const instance = await tx.runtimeInstance.findUnique({
          where: { id: row.id },
          include: INSTANCE_INCLUDE,
        });
        if (instance?.phase !== "STARTING" || instance.desiredState !== "RUNNING") return;
        // Again under the fence: another replica may have prepared it meanwhile.
        const run = await resolveRun(tx, row.id);
        if (await this.runPrepared(tx, row.id, run)) return;
        await this.createGeneration(tx, instance, run, instance.operationId);
      }).catch((error: unknown) =>
        console.error("[lifecycle] preparing a start failed", errorName(error)),
      );
    }
  }

  private async runPrepared(db: Tx, instanceId: string, run: number): Promise<boolean> {
    const prepared = await db.instanceStep.count({
      where: { instanceId, generation: run, phase: { in: [...START_PHASES] } },
    });
    return prepared > 0;
  }

  /** The steps of run `run` (the instance's current run, under this write's fence). */
  private async createGeneration(
    tx: Tx,
    instance: InstanceRow,
    run: number,
    operationId: string | null,
  ) {
    const launch = launchOf(instance);
    if (!launch) {
      // The launched version cannot be read (should not happen: versions are validated).
      await this.gangStop(tx, instance, "definition_invalid");
      return;
    }
    const ranks = instance.Ranks.filter((rank) => rank.nodeId !== null);
    // The leading stop of a restart names what each rank runs now (an earlier version's
    // process, port and unit), so the node stops that process.
    const physical = new Map<number, Physical>();
    if (run > 1)
      for (const rank of ranks) {
        const found = await this.physical(tx, instance, rank.rank);
        if (found) physical.set(rank.rank, found);
      }
    const steps = generationSteps({
      instance: instanceInput(instance),
      ranks: ranks.map(rankInput),
      launch,
      generation: run,
      operationId,
      physical,
      reservations: stepReservations(instance),
    });
    await this.insertSteps(tx, instance, run, steps);
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
        healthDetail: null,
        cacheGeneration: `${instance.id}:${run}`,
      },
    });
  }

  /**
   * What physically runs on a rank: the stored intent of its latest launch (any run) and that
   * version's launch. Undefined when nothing was ever launched there (the instance's own launch
   * then: the node proves absence from its missing record).
   */
  private async physical(
    tx: Tx,
    instance: InstanceRow,
    rank: number,
  ): Promise<Physical | undefined> {
    const stored = await physicalLaunch(tx, instance.id, rank);
    const intent = stepIntentSchema.safeParse(stored?.intent ?? null);
    if (!intent.success) return undefined;
    let launch = launchOf(instance);
    if (intent.data.launchVersionId !== instance.launchVersionId) {
      // Owner-scoped, like the command author's lookup (`stepCommandAuthor`).
      const version = await tx.runtimeVersion.findFirst({
        where: { id: intent.data.launchVersionId, Runtime: { userId: instance.userId } },
        select: { spec: true },
      });
      const spec = version?.spec;
      const parsed = runtimeLaunchSchema.safeParse(
        spec && typeof spec === "object" && "launch" in spec ? Reflect.get(spec, "launch") : null,
      );
      if (parsed.success) launch = parsed.data;
    }
    return launch ? { intent: intent.data, launch, headAddr: stored?.headAddr ?? null } : undefined;
  }

  /**
   * Every step is created here, in the instance's current run `run` (read under this write's
   * fence; the SQL trigger `instance_run_order` refuses any other generation too).
   */
  private async insertSteps(tx: Tx, instance: InstanceRow, run: number, steps: readonly NewStep[]) {
    const rankByNumber = new Map(instance.Ranks.map((rank) => [rank.rank, rank]));
    for (const step of steps) {
      if (step.generation !== run || run < 1)
        throw new Error("A new step belongs to its instance's current run.");
      const rank = rankByNumber.get(step.rank);
      if (!rank?.nodeId) continue;
      await tx.instanceStep.create({
        data: {
          instanceId: instance.id,
          nodeId: rank.nodeId,
          rank: step.rank,
          phase: step.phase,
          sequence: step.sequence,
          generation: step.generation,
          intent: step.intent,
          intentHash: step.intentHash,
          headAddr: step.headAddr ?? null,
        },
      });
    }
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

  /**
   * Settles up to `BATCH * 4` STOPPING instances a tick, least recently taken first
   * (`lastStopReconcileAt`, never taken first), so every stopping instance is reached however
   * many there are. When a pass is full, each is claimed before its settle runs, in its own write
   * that only succeeds while the stamp is the one read: an instance whose settle keeps failing
   * still goes to the back of the line, and one another server process took first is skipped.
   */
  private async reconcileStopping() {
    // sweep: stamp rotation (lastStopReconcileAt, ./sweep.ts)
    const rows = await prisma.runtimeInstance.findMany({
      where: { phase: "STOPPING", desiredState: { not: null } },
      select: { id: true, userId: true, lastStopReconcileAt: true },
      orderBy: [
        { lastStopReconcileAt: { sort: "asc", nulls: "first" } },
        { phaseChangedAt: "asc" },
        { id: "asc" },
      ],
      take: BATCH * 4,
    });
    // Rotation only matters once a pass cannot take them all; below that every one settles each
    // tick and nothing is written.
    const rotate = rows.length === BATCH * 4;
    for (const row of rows) {
      const claimed = !rotate
        ? { count: 1 }
        : await prisma.runtimeInstance
            .updateMany({
              where: {
                id: row.id,
                phase: "STOPPING",
                lastStopReconcileAt: row.lastStopReconcileAt,
              },
              data: { lastStopReconcileAt: this.now() },
            })
            .catch((error: unknown) => {
              console.error("[lifecycle] claiming a stop to reconcile failed", errorName(error));
              return { count: 0 };
            });
      if (claimed.count === 0) continue;
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
    // The run that owns the claims: its gang stops and probes are created at it.
    const run = await resolveRun(tx, instance.id);
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
    // This run's gang stops (not its leading stop, not status probes).
    const stopSteps = await tx.instanceStep.findMany({
      where: {
        instanceId: instance.id,
        generation: run,
        phase: "STOP",
        sequence: { gte: run * GENERATION_STRIDE + STOP_ORDER_BASE },
      },
      select: { rank: true, state: true, errorCode: true },
    });
    let needsMarkStopped = false;
    // Claims as they are now (a caller's copy may predate a release in this transaction).
    const current = await tx.instanceRank.findMany({ where: { instanceId: instance.id } });
    for (const rank of current) {
      if (rank.claim !== "HELD") continue;
      // Provably never ran since the last proven stop (evaluated by the release itself).
      if (await releaseClaim(tx, rank.id, now, { neverRan: true })) continue;
      const stops = stopSteps.filter((step) => step.rank === rank.rank);
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
        const probeUnproven = await this.probeStoppingRank(tx, instance, rank, launch, run, now);
        if (probeUnproven || failed.some((step) => step.errorCode === OPERATOR_CANCELLED))
          needsMarkStopped = true;
        continue;
      }
      // A gang stop of this run, naming what physically runs on the rank.
      await this.insertSteps(tx, instance, run, [
        stopStep({
          instance: instanceInput(instance),
          rank: rankInput(rank),
          nnodes: instance.Ranks.length,
          launch,
          generation: run,
          attempt: stops.length,
          operationId: instance.operationId,
          physical: await this.physical(tx, instance, rank.rank),
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
    run: number,
    now: Date,
  ): Promise<boolean> {
    if (rank.nodeId === null) return true;
    // An offline node gets its probe when it is back; a person is asked only once it has been
    // away for MARK_STOPPED_AFTER_OFFLINE_MS (a node connected to another server process is online).
    if (await this.offlineSince(tx, rank.nodeId, 0))
      return this.offlineSince(tx, rank.nodeId, MARK_STOPPED_AFTER_OFFLINE_MS);
    const probes = await tx.instanceStep.findMany({
      where: { instanceId: instance.id, rank: rank.rank, generation: run, phase: "STATUS" },
      select: { state: true, updatedAt: true },
    });
    const finished = probes.filter(
      (probe) => !(LIVE_STEP_STATES as readonly string[]).includes(probe.state),
    );
    // A probe on its way: wait for it (a person is asked only if an earlier one failed).
    if (probes.length > finished.length) return finished.length > 0;
    const latest = Math.max(0, ...finished.map((probe) => probe.updatedAt.getTime()));
    if (finished.length === 0 || latest <= now.getTime() - HELD_UNKNOWN_PROBE_MS)
      await this.insertSteps(tx, instance, run, [
        stopStep({
          instance: instanceInput(instance),
          rank: rankInput(rank),
          nnodes: instance.Ranks.length,
          launch,
          generation: run,
          attempt: await this.nextStatusAttempt(tx, instance.id, rank.rank),
          operationId: null,
          phase: "STATUS",
          physical: await this.physical(tx, instance, rank.rank),
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
    const rows = await this.sweeps.restart.next((page) =>
      prisma.runtimeInstance.findMany({
        where: {
          ...page.where,
          desiredState: "RUNNING",
          phase: "STOPPED",
          nextRestartAt: { lte: this.now() },
          // An inactive owner's instance never starts (it restarts once the owner is active).
          Runtime: { User: activeOwner(this.now()) },
        },
        select: { id: true, userId: true },
        orderBy: page.orderBy,
        take: page.take,
      }),
    );
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
    if (
      instance.Ranks.some((rank) => rank.nodeId === null) ||
      reservationsOf(instance).some((reservation) => reservation.nodeId === null)
    ) {
      // A rank's (or reservation's) node was deleted: nothing to restart on.
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
    // Its claims were released while it backed off: another start may have taken the room.
    // The planner checks it like a start's (the same budgets, under this owner fence): ranks on
    // their own nodes and ports, reservations by their labels. No room: it stays STOPPED and
    // tries again later, without spending its restart budget. (An unreadable launch is failed
    // by createGeneration below.)
    const launch = launchOf(instance);
    const plan = launch
      ? await planRetake(
          tx,
          {
            id: instance.id,
            userId: instance.userId,
            runtimeId: instance.runtimeId,
            launchVersionId: instance.launchVersionId,
            startedBy: instance.startedBy,
            ranks: instance.Ranks.flatMap((rank) =>
              rank.nodeId
                ? [
                    {
                      rank: rank.rank,
                      nodeId: rank.nodeId,
                      port: rank.port,
                      distPort: rank.distPort,
                    },
                  ]
                : [],
            ),
            reservations: reservationsOf(instance),
          },
          launch,
          now,
        )
      : null;
    if (plan && !plan.ok) {
      await tx.runtimeInstance.update({
        where: { id: instance.id },
        data: {
          // Why, for the runtime page and agents: `waiting_<refusal reason>` (not enough
          // memory, a port in use, a node offline or on hold, ...).
          phaseReason: waitingReason(plan.refusal.reason),
          nextRestartAt: new Date(now.getTime() + RETAKE_RETRY_MS),
        },
      });
      return;
    }
    // Always through the one retake, which begins the new run: a run proven stopped leaves no
    // reservation row (a superseded one included) that the retaken claim would hold again.
    const run = await retakeInstanceClaims(tx, {
      instanceId: instance.id,
      now,
      // An unreadable launch (failed by createGeneration below) plans none: the old run's
      // rows go (it stopped) or stay superseded while it may still run.
      reservations: plan ? plan.start.reservations : [],
      writeRanks: async (claim) => {
        await tx.instanceRank.updateMany({
          where: { instanceId: instance.id },
          // The stopping instances whose room on these nodes the plan counted on: START waits.
          data: { ...claim, blockedBy: plan ? plan.start.blockedBy : [] },
        });
        if (!plan) return;
        // The GPUs the planner picked are recorded with the claims (as a start's are).
        const ranks = [...instance.Ranks].sort((a, b) => a.rank - b.rank);
        for (const placement of plan.start.placements) {
          const rank = ranks[placement.nodeNumber - 1];
          if (!rank || canonicalJson(rank.resources) === canonicalJson(placement.resources))
            continue;
          await tx.instanceRank.update({
            where: { id: rank.id },
            data: { resources: placement.resources as Prisma.InputJsonObject },
          });
        }
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
        // The fabric the plan chose (a multi-node instance; `settleStopped` cleared the old
        // one), as a start's (`writePlannedStarts`): its steps resolve the head address on it.
        // No fabric fits: the planner refused above and the restart waits.
        fabricId: plan?.start.fabric?.fabricId ?? null,
      },
    });
    const fresh = await tx.runtimeInstance.findUniqueOrThrow({
      where: { id: instance.id },
      include: INSTANCE_INCLUDE,
    });
    await this.createGeneration(tx, fresh, run, fresh.operationId);
  }

  // ── Live instances: readiness, health, unavailability ──

  private async watchLive() {
    const rows = await this.sweeps.watch.next((page) =>
      prisma.runtimeInstance.findMany({
        where: { ...page.where, desiredState: "RUNNING", phase: { in: [...LIVE_PHASES] } },
        select: { id: true, userId: true },
        orderBy: page.orderBy,
        take: page.take,
      }),
    );
    for (const row of rows) {
      await this.write(row.userId, row.id, async (tx) => {
        const instance = await tx.runtimeInstance.findUnique({
          where: { id: row.id },
          include: INSTANCE_INCLUDE,
        });
        // Again under the fence: the row was read before it, and a crash or stop meanwhile may
        // have ended the run (a FAILED instance must not come back as UNAVAILABLE or STARTING).
        if (instance?.desiredState !== "RUNNING") return;
        if (!(LIVE_PHASES as readonly string[]).includes(instance.phase)) return;
        await this.watchInstance(tx, instance);
      }).catch((error: unknown) =>
        console.error("[lifecycle] watching an instance failed", errorName(error)),
      );
    }
    await this.pruneHealth();
  }

  private async watchInstance(tx: Tx, instance: InstanceRow) {
    const now = this.now();
    // The run is persisted before anything here changes the phase: a legacy row's committed,
    // unprepared restart is read from its phase and operation (`resolveRun`), and nothing below
    // may lose it.
    const run = await resolveRun(tx, instance.id);
    const nodeIds = instance.Ranks.flatMap((rank) => (rank.nodeId ? [rank.nodeId] : []));
    // A reservation's node (`launch.reservations`) is watched like a rank's: the instance's
    // launcher uses it, so its loss makes the instance UNAVAILABLE and stops it like a group's.
    const reservations = reservationsOf(instance);
    const reservationNodeIds = reservations.flatMap((reservation) =>
      reservation.nodeId ? [reservation.nodeId] : [],
    );
    const watched = [...new Set([...nodeIds, ...reservationNodeIds])];
    const deleted =
      nodeIds.length !== instance.Ranks.length || reservationNodeIds.length !== reservations.length;
    // The durable connection state (any replica's sessions), not this process's map. Right
    // after this process started, nodes are still reconnecting: nothing is marked yet.
    const rows = await tx.node.findMany({
      where: { id: { in: watched } },
      select: { id: true, connection: true, lastDisconnectedAt: true, lastHeartbeatAt: true },
    });
    const onlineIds = new Set(
      rows.filter((node) => offlineSinceOf(node, now) === null).map((node) => node.id),
    );
    const offline = watched.filter((nodeId) => !onlineIds.has(nodeId));
    if (offline.length > 0 && now.getTime() - this.startedAt < STARTUP_GRACE_MS) return;
    if (offline.length > 0 || deleted) {
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
      // A rank's or reservation's node that was deleted never comes back: stop now. Otherwise
      // the online ranks of a multi-node instance, or of one with reservations, stop after
      // unavailableStopMs (their GPUs and reserved memory are freed).
      if (deleted) await this.gangStop(tx, instance, "node_deleted");
      else if (
        instance.Ranks.length + reservations.length > 1 &&
        now.getTime() - since.getTime() >= advancedInt(instance, "unavailableStopMs")
      )
        await this.gangStop(tx, instance, "node_offline");
      return;
    }
    if (instance.phase === "UNAVAILABLE") {
      // Back: READY if this run had reached readiness (health probes confirm), else STARTING
      // (a restart committed meanwhile has no readiness of its own: an earlier run's says nothing).
      const ready = await tx.instanceStep.count({
        where: { instanceId: instance.id, generation: run, phase: "READINESS", state: "SUCCEEDED" },
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
    const run = await resolveRun(tx, instance.id);
    await this.insertSteps(tx, instance, run, [
      healthStep({
        instance: instanceInput(instance),
        head: rankInput(head),
        nnodes: instance.Ranks.length,
        launch,
        generation: run,
        sequence: (latest._max.sequence ?? HEALTH_SEQUENCE_BASE - 1) + 1,
        reservations: stepReservations(instance),
      }),
    ]);
  }

  private async pruneHealth() {
    // Finished probes only (bounded: a WHERE on phase, state and age).
    await this.sweeps.prune
      .next((page) =>
        prisma.instanceStep.findMany({
          where: {
            ...page.where,
            phase: "HEALTH",
            state: { in: ["SUCCEEDED", "FAILED", "CANCELLED"] },
            updatedAt: { lt: new Date(this.now().getTime() - HEALTH_HISTORY_MS) },
          },
          select: { id: true, Instance: { select: { userId: true, id: true } } },
          orderBy: page.orderBy,
          take: page.take,
        }),
      )
      .then(async (rows) => {
        const byOwner = new Map<string, string[]>();
        for (const row of rows) {
          const list = byOwner.get(row.Instance.userId) ?? [];
          list.push(row.id);
          byOwner.set(row.Instance.userId, list);
        }
        // One owner's failing write does not hold the others' back.
        for (const [userId, ids] of byOwner)
          await graphWrite([userId], (tx) =>
            tx.instanceStep.deleteMany({ where: { id: { in: ids }, phase: "HEALTH" } }),
          ).catch((error: unknown) =>
            console.error("[lifecycle] pruning probes failed", errorName(error)),
          );
      })
      .catch((error: unknown) =>
        console.error("[lifecycle] pruning probes failed", errorName(error)),
      );
  }

  // ── Deadlines ──

  private async expireSteps() {
    const now = this.now();
    const page = await this.sweeps.expire.next((page) =>
      prisma.instanceStep.findMany({
        where: {
          ...page.where,
          state: "RUNNING",
          deadline: { lte: now },
          OR: [
            // A person's run (of any run) is never expired; only its need is raised (once,
            // below), which takes it out of this sweep.
            { operatorAcceptedAt: null },
            { Instance: { needsOperator: null } },
          ],
        },
        select: {
          id: true,
          instanceId: true,
          deadline: true,
          Instance: { select: { userId: true } },
        },
        orderBy: page.orderBy,
        take: page.take,
      }),
    );
    for (const row of byKey(page, (row) => row.deadline?.getTime() ?? 0)) {
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
    const page = await this.sweeps.dispatch.next((page) =>
      prisma.instanceStep.findMany({
        where: {
          ...page.where,
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
        select: {
          id: true,
          nodeId: true,
          instanceId: true,
          sequence: true,
          createdAt: true,
          Instance: { select: { userId: true } },
        },
        orderBy: page.orderBy,
        take: page.take,
      }),
    );
    // Steps that wait (their turn, a blocker, a person's run) stay PENDING: the cursor reaches
    // the rest. A page goes out in sequence order, then creation order.
    const rows = [...page].sort(
      (a, b) => a.sequence - b.sequence || a.createdAt.getTime() - b.createdAt.getTime(),
    );
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
    session: {
      connectionGeneration: number;
      trust: NodeTrustWire;
      operatorTerminals?: boolean;
      jobReservations?: boolean;
    },
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
    // One gate for every phase: a step of an earlier run (prepared before a restart was
    // committed, or re-queued after a lost session) never goes out. Its run no longer owns the
    // claims; the current run's own steps (its leading stop first) take over.
    const run = await resolveRun(tx, instance.id);
    if (!owned(step, run)) {
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
    // A stop for a claim released meanwhile has nothing to stop (a leading stop of a new run
    // always has its claim HELD), and a probe of a claim that is no longer marked stopped would act
    // on the run in progress: neither goes out.
    if (step.phase === "STOP" || step.phase === "STATUS") {
      const claim = instance.Ranks.find((rank) => rank.rank === step.rank)?.claim;
      if (
        claim === "RELEASED" ||
        (step.phase === "STATUS" && !statusProbeWanted(instance, claim))
      ) {
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
      if (instance.desiredState !== "RUNNING") return null;
      if (startPhase && instance.phase !== "STARTING") return null;
      if (step.phase === "HEALTH" && instance.phase !== "READY" && instance.phase !== "UNHEALTHY")
        return null;
      // A banned or deleting owner's instance never starts (or runs anything but stops and
      // status probes); the step waits, and is cancelled if a person would have to answer it.
      if (!(await this.ownerActive(tx, instance.userId))) return null;
    }
    if (step.phase !== "HEALTH") {
      // Confirm screens of earlier runs that nobody accepted are closed: nobody answers them
      // now, and they would hold this run's stops back. A person's run already accepted keeps
      // running and is waited for below.
      await this.settleOperatorSteps(tx, instance.id, ALL_STEP_PHASES, "superseded", {
        before: run,
      });
      if (
        isLeadingStop(step) &&
        (await tx.instanceStep.count({
          where: {
            instanceId: instance.id,
            rank: step.rank,
            generation: { lt: run },
            phase: { in: [...START_PHASES] },
            state: { in: ["RUNNING", "AWAITING_OPERATOR"] },
          },
        })) > 0
      )
        // This run's leading stop proves every earlier launch of the rank ended: it waits until
        // each one sent earlier answered (its result, its deadline, or its session's loss).
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
    if (!node || !nodeOwnerMatches(node, instance.userId, "runtime_step")) return null;
    if (node.connectionGeneration !== session.connectionGeneration) return null;
    const fullControl =
      node.trust === "FULL" && node.trustLowerRequestedAt === null && session.trust === "full";
    // Agents cannot start anything on a Relay-only node, on any path (owner decision): nor
    // reserve memory on one (a reservation node lowered after placement; a deleted one counts
    // as not Full, as for ranks).
    if (
      startPhase &&
      instance.startedBy === "AGENT" &&
      (!fullControl ||
        reservationsOf(instance).some(
          (row) => row.Node === null || effectiveTrust(row.Node) !== "FULL",
        ))
    ) {
      await this.failStep(tx, step.id, "trust_relay");
      await this.afterStep(tx, step, false, "trust_relay");
      return null;
    }
    // A run with reservations tells its commands which nodes they got (the job's
    // `reservations`). A CLI from before them refuses such a job outright, so the start fails
    // here, saying to upgrade; its stops and probes go without them.
    if (startPhase && stepJobReservations(intent.data) && session.jobReservations !== true) {
      await this.failStep(tx, step.id, CLI_UPGRADE_REQUIRED);
      await this.afterStep(tx, step, false, CLI_UPGRADE_REQUIRED);
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
      // This run's leading stop (generation > 1) succeeded: the runs whose claims a restart
      // kept (superseded reservations, the ranks' previous claims) have stopped, so those stop
      // holding now.
      await dropSupersededHolds(tx, instance.id, step.generation);
      // Queued behind instances this operation stops: wait until they released.
      const blockers = [...new Set(instance.Ranks.flatMap((rank) => rank.blockedBy))];
      if (blockers.length > 0) {
        // Only the blockers' claims on the nodes this start uses: a blocker rank stuck on
        // another (offline) node frees nothing here and must not hold the start forever.
        // Reservation nodes count too: what a blocker holds there is used once this runs.
        // Held means not RELEASED, as placement counts it: a claim marked stopped
        // (HELD_UNKNOWN) may still be running and keeps its memory until a proof or a person
        // releases it, and a reservation holds while one of its instance's ranks does.
        const startNodes = [...instance.Ranks, ...reservationsOf(instance)].flatMap((row) =>
          row.nodeId ? [row.nodeId] : [],
        );
        const holding =
          (await tx.instanceRank.count({
            where: {
              instanceId: { in: blockers },
              claim: { not: "RELEASED" },
              nodeId: { in: startNodes },
            },
          })) +
          (await tx.instanceReservation.count({
            where: {
              instanceId: { in: blockers },
              nodeId: { in: startNodes },
              ...HOLDING_RESERVATION_WHERE,
            },
          }));
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
    // A stop or status probe names the head address its launch was dispatched with (recorded on
    // the step), so it still reaches a surviving rank after the head's node was deleted; every
    // other step (and one recorded before steps kept it) resolves the head's fabric address now.
    let headAddr: string | null =
      intent.data.nnodes > 1 && (step.phase === "STOP" || step.phase === "STATUS")
        ? (step.headAddr ?? null)
        : null;
    if (intent.data.nnodes > 1 && !headAddr) {
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
    // A fresh terminal per dispatch (ids are never reused), with who wrote the command: the
    // author of the version the job names (a stop of a restart's earlier launch names that
    // launch's version, never the successor's).
    const operator = interactive
      ? {
          terminalId: randomBytes(16).toString("base64url"),
          commandAuthor: await this.stepCommandAuthor(tx, instance, intent.data.launchVersionId),
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
        // Sent again after a counted dispatch: that one may have run (it is never forgotten,
        // whatever this attempt answers).
        mayHaveRun: mayHaveRunAfterRequeue(step.attempts),
        deadline,
        leaseExpiresAt: deadline,
        notBefore: null,
        operatorHold: null,
        // What it is sent with: a later stop of this launch names the same head.
        ...(headAddr ? { headAddr } : {}),
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
      jobReservations: session.jobReservations === true,
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
   * Whether a step waits for its person: of the instance's current run, an interactive step
   * AWAITING_OPERATOR (terminal open or closed), a held one, or a person's run past its
   * timeout; of any run, a person's accepted run past its timeout (`overdueAcceptedRun`).
   * An earlier run's screens never raise (or keep) the need: whatever answers them, the
   * successor's need is computed from its own steps. An earlier run's accepted command still
   * runs on the node and the successor's stops wait behind it, so once it is past its timeout
   * its person is asked to look at it (the need is attention only: it authorizes nothing, and
   * the step's answer still changes nothing about the successor). The need also takes the step
   * out of the deadline sweep, which never cuts a person's run off.
   */
  private async operatorStepWaiting(tx: Tx, instanceId: string): Promise<boolean> {
    const run = await resolveRun(tx, instanceId);
    const waiting = await tx.instanceStep.count({
      where: {
        instanceId,
        OR: [
          {
            generation: run,
            OR: [{ state: "AWAITING_OPERATOR" }, { state: "PENDING", operatorHold: { not: null } }],
          },
          overdueAcceptedRun(this.now()),
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
   * Closes a step's operator terminal unless its person's run is in progress (`closeOperatorStep`
   * with `keepRunning`), and reconciles that run: the relay saw `operator_running` (the person
   * pressed Enter) while this database has no acceptance (its write failed, R5-B-1). The
   * acceptance is recorded now, as `operatorProgress` would have (RUNNING, accepted, the step's
   * deadline counted from when its screen came up), so its stops keep waiting for it and, past its timeout, its
   * person is asked whatever run it belongs to (`overdueAcceptedRun`). Only the step's own
   * physical bookkeeping changes: no run, claim or successor state.
   */
  private async closeOperatorKeepingRun(
    tx: Tx,
    step: StepRow,
    actor?: "USER",
  ): Promise<"closed" | "running" | "absent" | undefined> {
    const answer = this.relay.closeOperatorStep?.(step.id, {
      keepRunning: true,
      ...(actor ? { actor } : {}),
    });
    if (
      answer !== "running" ||
      step.operatorAcceptedAt !== null ||
      (step.state !== "AWAITING_OPERATOR" && step.state !== "RUNNING") ||
      !interactiveIntent(step.intent)
    )
      return answer;
    const intent = stepIntentSchema.parse(step.intent);
    const now = this.now();
    // When the person pressed Enter is not known: no earlier than its screen came up. The
    // deadline counts from then (attention may come early, never late; it authorizes nothing).
    const since = step.operatorSince ?? now;
    const deadline = new Date(since.getTime() + intent.timeoutMs);
    const changed = await tx.instanceStep.updateMany({
      where: {
        id: step.id,
        state: step.state,
        ownerEpoch: step.ownerEpoch,
        operatorAcceptedAt: null,
      },
      // Acceptance implies the screen came up (CHECK `instance_step_operator_shape`): a lost
      // `awaiting_operator` write left `operatorSince` null, so it is recorded now too.
      data: {
        state: "RUNNING",
        deadline,
        leaseExpiresAt: deadline,
        operatorSince: since,
        operatorAcceptedAt: now,
      },
    });
    if (changed.count > 0) await this.syncNeedsOperator(tx, step.instanceId);
    return answer;
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
    options: { before?: number } = {},
  ): Promise<number> {
    const steps = await tx.instanceStep.findMany({
      where: {
        instanceId,
        phase: { in: [...phases] },
        // Only steps of runs before this one (`before`: the current run).
        ...(options.before !== undefined ? { generation: { lt: options.before } } : {}),
        OR: [
          { state: "AWAITING_OPERATOR" },
          { state: "RUNNING", operatorTerminalId: { not: null }, operatorAcceptedAt: null },
        ],
      },
    });
    let settled = 0;
    for (const step of steps) {
      if (!interactiveIntent(step.intent)) continue;
      if ((await this.closeOperatorKeepingRun(tx, step)) === "running") continue;
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
    if ((await this.closeOperatorKeepingRun(tx, step)) === "running") return false;
    const attempts = attemptsAfterServerClose(step);
    const changed = await tx.instanceStep.updateMany({
      where: { id: step.id, state: step.state, ownerEpoch: step.ownerEpoch },
      data: {
        state: "PENDING",
        ownerEpoch: null,
        deadline: null,
        leaseExpiresAt: null,
        ...NO_OPERATOR,
        attempts,
        // A dispatch that keeps its attempt (its screen was up) may have run.
        mayHaveRun: attempts === step.attempts ? mayHaveRunAfterRequeue(attempts) : undefined,
      },
    });
    if (changed.count === 0) return false;
    await this.syncNeedsOperator(tx, step.instanceId);
    return true;
  }

  /**
   * An earlier run's interactive step reported its screen up or closed: its terminal closes (a
   * person's run in progress is left alone) and it ends FAILED `superseded`, or CANCELLED when
   * nothing ran (a decline gives its attempt back, as `operatorClosed`).
   */
  private async settleSupersededOperator(tx: Tx, step: StepRow, result: JobResult) {
    if (
      result.status === "awaiting_operator" &&
      (await this.closeOperatorKeepingRun(tx, step)) === "running"
    )
      return;
    const attempts =
      result.status === "operator_closed" &&
      result.exitCode === undefined &&
      step.operatorAcceptedAt === null
        ? Math.max(0, step.attempts - 1)
        : step.attempts;
    const changed = await tx.instanceStep.updateMany({
      where: { id: step.id, state: step.state, ownerEpoch: step.ownerEpoch },
      data: {
        state: attempts === 0 ? "CANCELLED" : "FAILED",
        errorCode: attempts === 0 ? null : "superseded",
        attempts,
        deadline: null,
        leaseExpiresAt: null,
        operatorTerminalId: null,
      },
    });
    if (changed.count > 0) await this.syncNeedsOperator(tx, step.instanceId);
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
    // operator_running: a repeat changes nothing. One socket delivers a dispatch's progress in
    // order, so a RUNNING dispatch with its terminal and no acceptance that reports a run lost
    // its `awaiting_operator` write (the screen was up): the acceptance is recorded all the
    // same, with the screen's time (CHECK `instance_step_operator_shape`).
    const lostScreen =
      step.state === "RUNNING" &&
      step.operatorAcceptedAt === null &&
      step.operatorTerminalId !== null &&
      interactiveIntent(step.intent);
    if (step.state !== "AWAITING_OPERATOR" && !lostScreen) return;
    const intent = stepIntentSchema.parse(step.intent);
    const deadline = new Date(now.getTime() + intent.timeoutMs);
    const changed = await tx.instanceStep.updateMany({
      where: { ...where, operatorAcceptedAt: null },
      data: {
        state: "RUNNING",
        deadline,
        leaseExpiresAt: deadline,
        operatorSince: step.operatorSince ?? now,
        operatorAcceptedAt: now,
      },
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
    // Also a terminal of this run still open on the node: its run may have begun before its
    // report (the node holds a stop behind it too, on the rank's lock). A person's accepted run
    // counts whatever run it belongs to (it still runs); an earlier run's open screen nobody
    // accepted was closed before this stop (claimStep).
    const running = await tx.instanceStep.count({
      where: {
        instanceId: step.instanceId,
        nodeId: step.nodeId,
        id: { not: step.id },
        OR: [
          { state: "RUNNING", operatorAcceptedAt: { not: null } },
          {
            state: "AWAITING_OPERATOR",
            operatorTerminalId: { not: null },
            generation: step.generation,
          },
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
      // A step of an earlier run (any phase) is never run again: its run no longer owns the
      // claims.
      if (!owned(step, await resolveRun(tx, instance.id)))
        throw new OperatorStepError("superseded");
      if (isStartPhase(step.phase)) {
        const current = instance.desiredState === "RUNNING" && instance.phase === "STARTING";
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
          // Reopened after a counted dispatch (its screen was up): that one may have run.
          mayHaveRun: mayHaveRunAfterRequeue(step.attempts),
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
      if ((await this.closeOperatorKeepingRun(tx, step, "USER")) === "running")
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

  /**
   * Who wrote the command of the version a job names: the instance's launch version, or (a stop
   * or status probe of an earlier launch) that version, read under the instance's owner. A
   * version not found is "unknown": never the successor's author.
   */
  private async stepCommandAuthor(
    tx: Tx,
    instance: InstanceRow,
    launchVersionId: string,
  ): Promise<"user" | "agent" | "unknown"> {
    if (launchVersionId === instance.launchVersionId)
      return commandAuthor(instance.LaunchVersion.editor);
    const version = await tx.runtimeVersion.findFirst({
      where: { id: launchVersionId, Runtime: { userId: instance.userId } },
      select: { editor: true },
    });
    return version ? commandAuthor(version.editor) : "unknown";
  }

  // ── Inactive (banned or deleting) owners ──

  private async ownerActive(tx: Tx, userId: string): Promise<boolean> {
    const owner = await tx.user.findUnique({
      where: { id: userId },
      select: { banned: true, banExpires: true, deletionRequestedAt: true },
    });
    return !!owner && !userCredentialAccessBlocked(owner, this.now());
  }

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
    const rows = await this.sweeps.drain.next((page) =>
      prisma.runtimeInstance.findMany({
        where: {
          ...page.where,
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
                some: {
                  phase: "STOP",
                  state: { in: ["FAILED", "CANCELLED"] },
                  intent: interactive,
                },
              },
            },
          ],
        },
        select: { id: true, userId: true },
        orderBy: page.orderBy,
        take: page.take,
      }),
    );
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
    const run = await peekRun(db, instanceId);
    return (await this.unanswerableStopRanks(db, instance, run)).size > 0;
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
    const generation = await resolveRun(tx, instanceId);
    let startCancelled = false;
    let stopCancelled = false;
    for (const step of await this.waitingInteractiveSteps(tx, instanceId)) {
      // Closed by step id on whichever session holds it; a person's run is left alone.
      const closed = step.state === "PENDING" ? null : await this.closeOperatorKeepingRun(tx, step);
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
          lastStopCheckAt: null,
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
        // A confirm screen of an earlier run (up, or closed without success): nobody answers it
        // now, so it is closed and the step ends; it changes nothing about the successor. A
        // person who already accepted it keeps running (recorded: its stops wait for it).
        if (
          result.status !== "operator_running" &&
          !owned(step, await resolveRun(tx, step.instanceId))
        ) {
          await this.settleSupersededOperator(tx, step, result);
          return;
        }
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
      await this.afterStep(tx, step, succeeded, code, healthFailureDetail(result.detail));
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
  /** `healthDetail`: why a failed health probe failed, when the node said. */
  private async afterStep(
    tx: Tx,
    step: FinishedStep,
    succeeded: boolean,
    code: string | null,
    healthDetail: string | null = null,
  ) {
    const { instanceId, phase, rank } = step;
    const instance = await tx.runtimeInstance.findUnique({
      where: { id: instanceId },
      include: INSTANCE_INCLUDE,
    });
    if (!instance) return;
    const now = this.now();
    // A step of an earlier run changes nothing about this one: no readiness, no failure, no
    // health, no release (its row keeps what physically happened).
    const mine = owned(step, await resolveRun(tx, instanceId));
    if (phase === "STOP" || phase === "STATUS") {
      const claim = instance.Ranks.find((row) => row.rank === rank);
      if (succeeded && claim) {
        // The node proved this rank stopped. `releaseClaim` decides whether that releases the
        // claim: a proof of this run, after its launches (the leading stop of a restart proves
        // only that the previous run ended: the claim stays, the new run uses it); a probe
        // releases a claim marked stopped, or a stopping run's.
        await releaseClaim(tx, claim.id, now, { result: { stepId: step.id } });
      } else if (!succeeded && mine && isLeadingStop(step) && instance.phase === "STARTING") {
        // The previous run could not be proven stopped: the new run must not start over it.
        await this.gangStop(tx, instance, "startup_failed");
        return;
      }
      if (instance.phase === "STOPPING") await this.settleStopping(tx, instance);
      return;
    }
    if (!mine) return;
    if (phase === "HEALTH") {
      await this.recordHealth(tx, instance, succeeded, healthDetail);
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
    const unfinished = await tx.instanceStep.count({
      where: {
        instanceId,
        generation: step.generation,
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
        healthDetail: null,
        unavailableSince: null,
        needsOperator: null,
        needsOperatorSince: null,
      },
    });
    await registerExecutionTargets(tx, instance);
  }

  private async recordHealth(
    tx: Tx,
    instance: InstanceRow,
    success: boolean,
    detail: string | null,
  ) {
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
        // Why the last probe failed, kept while the instance is UNHEALTHY; READY clears it.
        ...(phase === "UNHEALTHY"
          ? success
            ? {}
            : { healthDetail: detail }
          : { healthDetail: null }),
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
   * A pass takes at most {@link BATCH} ranks that are due, least recently checked first, and
   * claims each one before checking it by stamping `lastStopCheckAt` while it is still due, so
   * every rank is reached however many there are, a rank whose check fails waits its turn like
   * the rest, and a rank another server process claimed first is skipped.
   */
  private async probeHeldUnknown() {
    const online = this.relay.onlineNodeIds?.();
    if (online && online.length === 0) return;
    const due = (): Prisma.InstanceRankWhereInput => ({
      claim: "HELD_UNKNOWN",
      OR: [
        { lastStopCheckAt: null },
        { lastStopCheckAt: { lte: new Date(this.now().getTime() - HELD_UNKNOWN_PROBE_MS) } },
      ],
    });
    // sweep: stamp rotation (lastStopCheckAt, ./sweep.ts)
    const ranks = await prisma.instanceRank.findMany({
      where: { ...due(), nodeId: online ? { in: online } : { not: null } },
      select: {
        id: true,
        nodeId: true,
        rank: true,
        instanceId: true,
        Instance: { select: { userId: true } },
      },
      orderBy: [{ lastStopCheckAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
      take: BATCH,
    });
    for (const rank of ranks) {
      // Claimed first, in its own write: a rank whose check keeps failing (or whose node has no
      // session here after all) still goes to the back of the line, and a rank another server
      // process just claimed is no longer due here.
      const claimed = await prisma.instanceRank
        .updateMany({ where: { id: rank.id, ...due() }, data: { lastStopCheckAt: this.now() } })
        .catch((error: unknown) => {
          console.error("[lifecycle] claiming a rank marked stopped failed", errorName(error));
          return { count: 0 };
        });
      if (claimed.count === 0 || !rank.nodeId || !this.relay.nodeSession(rank.nodeId)) continue;
      await this.write(rank.Instance.userId, rank.instanceId, async (tx) => {
        const checkedAt = await this.probeHeldRank(tx, rank);
        await tx.instanceRank.updateMany({
          where: { id: rank.id, claim: "HELD_UNKNOWN" },
          data: { lastStopCheckAt: checkedAt },
        });
      }).catch((error: unknown) =>
        console.error("[lifecycle] probing a rank marked stopped failed", errorName(error)),
      );
    }
  }

  /**
   * One check of a rank marked stopped: a status probe goes out unless one is on its way or
   * finished within {@link HELD_UNKNOWN_PROBE_MS}. Returns the rank's check time: the last
   * probe's when one finished recently (the next check falls due as that probe ages out), now
   * otherwise.
   */
  private async probeHeldRank(
    tx: Tx,
    rank: { id: string; rank: number; instanceId: string },
  ): Promise<Date> {
    const now = this.now();
    // This run's probes (an earlier run's never goes out, and says nothing about this one).
    const run = await resolveRun(tx, rank.instanceId);
    const recent = await tx.instanceStep.findMany({
      where: {
        instanceId: rank.instanceId,
        rank: rank.rank,
        phase: "STATUS",
        generation: run,
        OR: [
          { state: { in: [...LIVE_STEP_STATES] } },
          { updatedAt: { gt: new Date(now.getTime() - HELD_UNKNOWN_PROBE_MS) } },
        ],
      },
      select: { state: true, updatedAt: true },
    });
    if (recent.length > 0) {
      if (recent.some((step) => (LIVE_STEP_STATES as readonly string[]).includes(step.state)))
        return now;
      return new Date(Math.max(...recent.map((step) => step.updatedAt.getTime())));
    }
    const instance = await tx.runtimeInstance.findUnique({
      where: { id: rank.instanceId },
      include: INSTANCE_INCLUDE,
    });
    const launch = instance ? launchOf(instance) : null;
    const row = instance?.Ranks.find((candidate) => candidate.id === rank.id);
    if (!instance || !launch || !row) return now;
    const attempts = await this.nextStatusAttempt(tx, instance.id, row.rank);
    await this.insertSteps(tx, instance, run, [
      stopStep({
        instance: instanceInput(instance),
        rank: rankInput(row),
        nnodes: instance.Ranks.length,
        launch,
        generation: run,
        attempt: attempts,
        operationId: null,
        phase: "STATUS",
        physical: await this.physical(tx, instance, row.rank),
      }),
    ]);
    return now;
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
          data: {
            state: "PENDING",
            ownerEpoch: null,
            deadline: null,
            leaseExpiresAt: null,
            // The lost dispatch may have reached the node: a later attempt's refusal does not
            // prove it never ran.
            mayHaveRun: mayHaveRunAfterRequeue(step.attempts),
          },
        });
      }).catch((error: unknown) => console.error(`[lifecycle] ${what} failed`, errorName(error)));
    this.wake();
  }

  /**
   * A complete inventory. Each record of a held rank names the last step the node ran for the
   * unit (`stepId`); only a record naming a step of the run that owns the claim, observed after
   * that run's launches (`owned` and `fresh`), is evidence:
   * - stopped, while STOPPING or marked stopped: proves the stop (`releaseClaim` observation);
   * - stopped or unknown in a live run (READY/UNHEALTHY): the run crashed (gang stop, then the
   *   restart rule);
   * - otherwise its engine facts are recorded.
   * A record naming an earlier run's step, or one before this run's launch, or an unknown step,
   * changes nothing and is reported back as stale (the relay keeps what it served for that
   * handle). A missing record, or one without a step id (nodes before 0.4.0), cannot be dated:
   * in a live run it makes a health probe due now, and the health thresholds decide.
   * Always-on instances follow their runtime's status.
   */
  async runtimeInventory(
    ref: NodeSessionRef,
    snapshot: RuntimeInventorySnapshot,
  ): Promise<{ ok: true; stale: string[] } | { ok: false; message: string }> {
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
    const stale = new Set<string>();
    // A record that could not be classified (its write failed) is neither evidence nor stale:
    // the snapshot is refused (`runtime.inventory.error`), so the relay keeps everything it
    // served, and the node's next inventory is classified again.
    let unclassified = false;
    for (const rank of ranks) {
      const record = reported.get(`${rank.instanceId}:${rank.rank}`);
      await this.write(ref.userId, rank.instanceId, async (tx) => {
        const instance = await tx.runtimeInstance.findUnique({
          where: { id: rank.instanceId },
          include: INSTANCE_INCLUDE,
        });
        const claim = instance?.Ranks.find((row) => row.id === rank.id);
        if (!instance || !claim || claim.nodeId !== ref.nodeId) return;
        const evidence = record?.stepId
          ? await this.inventoryEvidence(tx, instance.id, claim.rank, ref.nodeId, record.stepId)
          : "undated";
        if (evidence === "stale") {
          if (record && record.rank === 0) stale.add(record.handle);
          return;
        }
        const live =
          (instance.phase === "READY" || instance.phase === "UNHEALTHY") &&
          instance.desiredState === "RUNNING";
        const lost = !record || record.phase === "stopped" || record.phase === "unknown";
        if (evidence === "undated") {
          // Nothing orders this against the run's launch: a health probe answers instead.
          if (live && lost && claim.claim === "HELD" && instance.lastHealthAt !== null)
            await tx.runtimeInstance.update({
              where: { id: instance.id },
              data: { lastHealthAt: null },
            });
          return;
        }
        if (record?.phase === "stopped") {
          if (instance.phase === "STOPPING" || claim.claim === "HELD_UNKNOWN") {
            await releaseClaim(tx, claim.id, this.now(), {
              observation: { stepId: evidence.stepId },
            });
            if (instance.phase === "STOPPING") await this.settleStopping(tx, instance);
            return;
          }
        }
        // A ready run whose rank the node no longer runs has crashed: gang stop, then the
        // restart rule.
        if (live && lost && claim.claim === "HELD") {
          await this.gangStop(tx, instance, "crashed");
          return;
        }
        if (record && claim.claim === "HELD" && instance.desiredState === "RUNNING")
          await this.recordInstanceFacts(tx, instance, record);
      }).catch((error: unknown) => {
        unclassified = true;
        console.error("[lifecycle] applying inventory failed", errorName(error));
      });
    }
    await applyAlwaysOnInventory(ref, snapshot.alwaysOn, this.now()).catch((error: unknown) =>
      console.error("[lifecycle] applying always-on inventory failed", errorName(error)),
    );
    this.wake();
    if (unclassified)
      return {
        ok: false,
        message: "The server could not apply the inventory; it is kept as it was.",
      };
    return { ok: true, stale: [...stale] };
  }

  /**
   * What an inventory record naming step `stepId` proves about this rank: evidence of the run
   * that owns the claim, after its launches (`owned` and `fresh`), or stale (an earlier run's
   * step, one observed before this run's launch, or a step that is not this rank's).
   */
  private async inventoryEvidence(
    tx: Tx,
    instanceId: string,
    rank: number,
    nodeId: string,
    stepId: string,
  ): Promise<{ stepId: string } | "stale"> {
    const step = await tx.instanceStep.findFirst({
      where: { id: stepId, instanceId, rank, nodeId },
      select: { phase: true, sequence: true, generation: true },
    });
    if (!step) return "stale";
    const run = await resolveRun(tx, instanceId);
    if (!owned(step, run) || !(await fresh(tx, { ...step, instanceId, rank }, run))) return "stale";
    return { stepId };
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
