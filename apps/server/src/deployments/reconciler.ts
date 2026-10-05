import { randomUUID } from "node:crypto";
import { notifyDeploymentOperatorNeeds } from "@ws-model-proxy/api/lib/deployment-operator-notify";
import { deploymentFingerprint } from "@ws-model-proxy/api/lib/deployment-planner";
import {
  DEPLOYMENT_OPERATOR_RESTART_LIMIT,
  deploymentCommandActor,
  deploymentExecutionAllowed,
  deploymentStartsInteractive,
  lockDeploymentNodes,
  lockDeploymentOwner,
  mintDeploymentOperator,
  deploymentIntentOperatorFlags as operatorFlags,
  syncDeploymentOperatorNeed,
} from "@ws-model-proxy/api/lib/deployment-service";
import {
  deploymentHealthIntent,
  deploymentJobIntentSchema as intentSchema,
  originalDeploymentStopIntent,
  storedDeploymentSpecSchema,
} from "@ws-model-proxy/api/lib/deployment-spec";
import {
  type DeploymentJob,
  type DeploymentJobResult,
  type DeploymentObservedInstance,
  deploymentOperatorResultStatus,
} from "@ws-model-proxy/config/deployment-protocol";
import prisma, { type Prisma } from "@ws-model-proxy/db";
import { acquireFences, fences } from "@ws-model-proxy/db/capacity-lock-order";
import { isDbShutdownFenceArmed } from "@ws-model-proxy/db/shutdown-fence";
import { userCredentialAccessBlocked } from "@ws-model-proxy/db/user-deletion-access";
import { z } from "zod";
import { MANAGED_IDENTITY_REFUSED } from "./managed-identity.js";
import { isDeploymentOperatorAction, recordDeploymentOperatorEvent } from "./operator-audit.js";

type Tx = Prisma.TransactionClient;
export type DeploymentSocket = {
  userId: string;
  cliDeviceId: string;
  generation: number;
};
/**
 * The live session's view of a socket. `inventoryComplete` is owned by that
 * session: it becomes true only after this reconciler committed the session's
 * latest complete inventory snapshot, and resets on a new snapshot, detach,
 * replacement, or shutdown. Reconnect inventory is required before adopting or
 * retrying any uncertain effect, so dispatch requires it for the exact current
 * generation.
 */
export type DeploymentLiveSocket = DeploymentSocket & {
  inventoryComplete: boolean;
  /**
   * The session can hold operator terminals for interactive jobs (2.4 +
   * deployments + `deploymentOperator` + terminal support and key; the CLI
   * reports the feature only with its operator-terminal switch on). Absent
   * means no. Interactive steps (and starts whose stop is interactive) are
   * never claimed for a session without it (design §12c).
   */
  deploymentOperator?: boolean;
  /** The session can track another operator terminal (false at its cap). */
  operatorRoom?: boolean;
};
export type DeploymentTransport = {
  current(deviceId: string): DeploymentLiveSocket | null;
  send(socket: DeploymentSocket, job: DeploymentJob): boolean;
  /**
   * Close the operator terminal of an interactive step by step id, on whichever
   * session holds it (design §12b: a PENDING reset loses `operatorTerminalId`).
   * `keepRunning` leaves a terminal whose command already runs (`running`).
   * Synchronous and DB-free, so the reconciler calls it under its row locks,
   * before the update that resets the step, and keeps the step when a
   * person's command still runs there.
   */
  closeOperatorStep?(
    stepId: string,
    options?: { keepRunning?: boolean },
  ): "closed" | "running" | "absent";
};
const BATCH = 64;
const STOP_GRACE = 60_000;
const BACKOFF = [30_000, 120_000, 300_000] as const;
/**
 * An interactive job that has not drawn its confirm screen within the CLI's own budget for
 * the job (queue time included; its deadline starts at admission) plus this grace is re-sent
 * with a fresh terminal. The copy still queued then fails as expired and names its own
 * terminal, so it settles nothing (§12j).
 */
const OPERATOR_SPAWN_GRACE = 60_000;
const OPERATOR_SPAWN_BUDGET_MAX = 900_000;
/** Live operator terminals of non-stop steps per node (design §4); stops are exempt. */
const OPERATOR_TERMINALS_PER_NODE = 4;
/**
 * Why a PENDING interactive step is held before its claim (`errorCode`, so the dashboard can
 * explain it). Written only over no code or another hold code: a stop's gang-stop reason stays.
 */
const OPERATOR_HOLD = {
  unsupported: "operator_capability_missing",
  sessionFull: "operator_session_full",
  nodeFull: "operator_node_full",
} as const;
const OPERATOR_HOLD_CODES: readonly string[] = Object.values(OPERATOR_HOLD);
/** A reset found the step replaced (a later generation, a stopping instance, a newer stop). */
const OPERATOR_SUPERSEDED = "operator_superseded";
/** The CLI refused an interactive job: its node-local operator-terminal switch is off. */
const OPERATOR_TERMINALS_DISABLED = "operator_terminals_disabled";
/** Final refusals of an interactive job (the CLI never ran it): not a stop to wait on. */
const OPERATOR_STOP_REFUSALS: readonly string[] = [
  "feature_disabled",
  "command_mode_denied",
  "interactive_unsupported",
  "bad_job",
];
/**
 * The owner is banned or deleting: their waiting operator steps are cancelled and claims
 * released (as held unknown), so account deletion never waits for a terminal nobody may
 * answer (design §12b policy).
 */
const OWNER_INACTIVE = "owner_inactive";
/** Gang-stop reason of the stop that checks whether a held-unknown rank's service stopped. */
const HELD_UNKNOWN_PROBE = "held_unknown_probe";
/** A failed or cancelled held-unknown status check is retried no sooner than this. */
const HELD_UNKNOWN_PROBE_RETRY = 300_000;
/** Probe stops get their own sequences, clear of the gang stops' `100 + 10 * generation`. */
const HELD_UNKNOWN_PROBE_SEQUENCE = 5000;
const LIVE_STEP_STATES = ["PENDING", "RUNNING", "AWAITING_OPERATOR"] as const;
/** How often the reconciler checks for "needs you" emails to send. */
const NEEDS_EMAIL_INTERVAL_MS = 30_000;
/** The audit action of an interactive step's intent (prepare, start, after_join or stop). */
function operatorAction(intent: Prisma.JsonValue) {
  const action =
    intent !== null && typeof intent === "object" && !Array.isArray(intent)
      ? intent.action
      : undefined;
  return typeof action === "string" && isDeploymentOperatorAction(action) ? action : null;
}
type StepRow = Prisma.DeploymentStepGetPayload<true>;
type InstanceRow = Pick<
  Prisma.DeploymentInstanceGetPayload<true>,
  "id" | "restartAttempts" | "desiredState" | "observedState"
>;
/** A banned (ban active now) or deletion-pending owner, as `userCredentialAccessBlocked`. */
const inactiveOwner = (now: Date): Prisma.UserWhereInput => ({
  OR: [
    { deletionRequestedAt: { not: null } },
    { banned: true, OR: [{ banExpires: null }, { banExpires: { gte: now } }] },
  ],
});
/**
 * The complement of {@link inactiveOwner}, spelled out: `NOT` over a nullable `banned` would
 * drop never-banned owners (`banned` NULL) in SQL's three-valued logic.
 */
const activeOwner = (now: Date): Prisma.UserWhereInput => ({
  deletionRequestedAt: null,
  OR: [{ banned: null }, { banned: false }, { banExpires: { lt: now } }],
});
const memberWhere = (instanceId: string): Prisma.PoolMemberWhereInput => ({
  OR: [
    { DiscoveredModel: { Endpoint: { deploymentInstanceId: instanceId } } },
    { ExecutionTarget: { DiscoveredModel: { Endpoint: { deploymentInstanceId: instanceId } } } },
  ],
});

/** All callbacks and ticks join at shutdown. One tick at a time; DB locks arbitrate replicas. */
export class DeploymentReconciler {
  private epoch = randomUUID();
  private stopped = false;
  private tickRunning: Promise<void> | null = null;
  private tasks = new Set<Promise<unknown>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stepCursor: { updatedAt: Date; id: string } | null = null;
  private retentionCursor: string | null = null;
  private drainCursor: string | null = null;
  private probeCursor: string | null = null;
  private revokedCursor: string | null = null;
  private lastNeedsEmailAt = 0;
  private instanceCursor: { updatedAt: Date; id: string } | null = null;
  private resultChains = new Map<string, Promise<unknown>>();
  constructor(
    private transport: DeploymentTransport,
    private db = prisma,
  ) {}

  start() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => this.wake(), 1000);
    this.timer.unref();
    this.wake();
  }
  wake() {
    if (this.stopped || this.tickRunning) return;
    this.tickRunning = this.track(this.tick())
      .catch(() => {
        console.error("[deployments] reconciliation failed");
      })
      .finally(() => {
        this.tickRunning = null;
      });
  }
  /** Explicit wake/join for operational probes; shares the single-tick guard. */
  async runOnce() {
    this.wake();
    await this.tickRunning;
  }
  private track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
    return task;
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.tasks]);
  }
  private current(socket: DeploymentSocket) {
    const current = this.transport.current(socket.cliDeviceId);
    return (
      !!current && current.generation === socket.generation && current.userId === socket.userId
    );
  }
  private async locked<T>(userId: string, instanceId: string, fn: (tx: Tx) => Promise<T>) {
    return this.db.$transaction(
      async (tx) => {
        // Graph owner fence precedes deployment owner and sorted node locks.
        await lockDeploymentOwner(tx, userId);
        const nodes = await tx.deploymentInstanceNode.findMany({
          where: { instanceId },
          select: { cliDeviceId: true },
        });
        const instance = await tx.deploymentInstance.findUnique({
          where: { id: instanceId },
          select: { Run: { select: { Plan: { select: { contents: true } } } } },
        });
        const affected = z
          .object({ affectedNodeIds: z.array(z.string()).max(4096) })
          .safeParse(instance?.Run.Plan.contents);
        const nodeIds = [
          ...new Set([
            ...nodes.map((n) => n.cliDeviceId),
            ...(affected.success ? affected.data.affectedNodeIds : []),
          ]),
        ].sort();
        await lockDeploymentNodes(tx, nodeIds);
        const targets = await tx.executionTarget.findMany({
          where: { DiscoveredModel: { Endpoint: { deploymentInstanceId: instanceId } } },
          select: { id: true, inferenceCapacityId: true },
        });
        await acquireFences(
          tx,
          targets.flatMap((t) => [
            fences.capacityPolicy(t.id),
            ...(t.inferenceCapacityId ? [fences.capacity(t.inferenceCapacityId)] : []),
          ]),
        );
        // Policy updates/hello also write these rows; acquire in sorted order before reading grants/budgets.
        for (const nodeId of nodeIds)
          await tx.$queryRaw`SELECT id FROM cli_device WHERE id = ${nodeId} AND "userId" = ${userId} FOR UPDATE`;
        return fn(tx);
      },
      { isolationLevel: "ReadCommitted", timeout: 30_000 },
    );
  }
  private async fenceSocket(tx: Tx, socket: DeploymentSocket) {
    // Matches registration's durable generation. The row lock serializes a newer hello.
    const rows = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM cli_device WHERE id = ${socket.cliDeviceId} AND "userId" = ${socket.userId} AND "connectionGeneration" = ${socket.generation} AND status = 'CONNECTED' FOR UPDATE`;
    return rows.length === 1 && this.current(socket);
  }
  acceptResult(socket: DeploymentSocket, result: DeploymentJobResult): Promise<boolean> {
    if (this.stopped || !this.current(socket)) return Promise.resolve(false);
    // Operator progress (never final) always names the terminal it reports on.
    const progress = deploymentOperatorResultStatus(result.status);
    if (progress && !result.terminalId) return Promise.resolve(false);
    // Results of one step apply in the order they arrived (the session manager calls this in
    // frame order): `operator_running` must never be overtaken by its own screen report.
    const previous = this.resultChains.get(result.stepId);
    const applied = (previous ?? Promise.resolve()).then(() =>
      this.applyResult(socket, result, progress),
    );
    const chained = applied.catch(() => {});
    this.resultChains.set(result.stepId, chained);
    void chained.finally(() => {
      if (this.resultChains.get(result.stepId) === chained) this.resultChains.delete(result.stepId);
    });
    return this.track(applied).finally(() => this.wake());
  }
  private applyResult(socket: DeploymentSocket, result: DeploymentJobResult, progress: boolean) {
    if (this.stopped || !this.current(socket)) return Promise.resolve(false);
    return this.locked(socket.userId, result.instanceId, async (tx) => {
      if (!(await this.fenceSocket(tx, socket))) return false;
      const step = await tx.deploymentStep.findFirst({
        where: {
          id: result.stepId,
          instanceId: result.instanceId,
          cliDeviceId: socket.cliDeviceId,
          rank: result.rank,
          intentHash: result.intentHash,
          ownerEpoch: result.ownerEpoch,
          // A final result can overtake its own "operator running" report (frames are
          // not serialised per session), so a waiting interactive step accepts it too.
          state: { in: ["RUNNING", "AWAITING_OPERATOR"] },
          Instance: { userId: socket.userId },
        },
        include: { Instance: true },
      });
      if (!step || step.ownerEpoch !== `${this.epoch}:${socket.generation}`) return false;
      const { interactive } = operatorFlags(step.intent);
      // Only an interactive step has operator progress or waits for a person.
      if (!interactive && (progress || step.state !== "RUNNING")) return false;
      // Every result of an interactive job names the terminal of the dispatch it answers;
      // a late answer to an earlier copy of the step (or after its terminal closed) settles
      // nothing (§12h L1).
      if (
        interactive &&
        (step.operatorTerminalId === null || result.terminalId !== step.operatorTerminalId)
      )
        return false;
      if (
        step.phase !== "stop" &&
        step.phase !== "health" &&
        Math.floor(step.sequence / 10) !== step.Instance.restartAttempts
      )
        return false;
      if (step.phase === "stop") {
        const latest = await tx.deploymentStep.findFirst({
          where: { instanceId: step.instanceId, rank: step.rank, phase: "stop" },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        });
        const start = await tx.deploymentStep.findFirst({
          where: { instanceId: step.instanceId, rank: step.rank, phase: "start" },
          orderBy: [{ sequence: "desc" }, { id: "desc" }],
        });
        if (latest?.id !== step.id || (start && step.createdAt < start.createdAt)) return false;
      }
      if (step.phase === "health" && step.Instance.restartAttempts > 0) {
        const start = await tx.deploymentStep.findFirst({
          where: { instanceId: step.instanceId, rank: step.rank, phase: "start" },
          orderBy: [{ sequence: "desc" }, { id: "desc" }],
        });
        if (start && step.createdAt < start.createdAt) return false;
      }
      if (progress) return this.operatorProgress(tx, step, result);
      if (result.status === "running") return true; // Progress never extends the absolute deadline.
      // The node's operator-terminal switch is off: a person must turn it on, so the step
      // waits for them (closed terminal, reopenable) instead of failing the deployment.
      if (interactive && result.status === "failed" && result.error === OPERATOR_TERMINALS_DISABLED)
        return this.operatorClosed(tx, step, { error: OPERATOR_TERMINALS_DISABLED });
      // An interactive stop that did not end with proof (the person's run left the service
      // alive, or execution failed) waits for its person again, claims held and reopenable:
      // automatic stops wait for the human (review M1). The CLI's refusals stay failures.
      if (
        interactive &&
        step.phase === "stop" &&
        result.status === "failed" &&
        !OPERATOR_STOP_REFUSALS.includes(result.error ?? "")
      )
        return this.operatorClosed(tx, step, { error: result.error ?? "job_failed" });
      const succeeded = result.status === "succeeded" && (step.phase !== "stop" || result.stopped);
      const changed = await tx.deploymentStep.updateMany({
        where: {
          id: step.id,
          state: step.state,
          ownerEpoch: step.ownerEpoch,
          intentHash: step.intentHash,
        },
        data: {
          state: succeeded ? "SUCCEEDED" : "FAILED",
          leaseExpiresAt: null,
          errorCode: succeeded ? null : (result.error ?? "job_failed"),
          // A success that overtook "operator running" records the acceptance in the same
          // update (the database refuses AWAITING_OPERATOR -> SUCCEEDED without it).
          ...(succeeded && step.state === "AWAITING_OPERATOR"
            ? { operatorAcceptedAt: step.operatorAcceptedAt ?? new Date() }
            : {}),
        },
      });
      if (!changed.count) return false;
      if (interactive) await this.syncNeedsOperator(tx, step.instanceId);
      if (step.phase === "stop") {
        const rank = {
          instanceId: step.instanceId,
          cliDeviceId: socket.cliDeviceId,
          rank: step.rank,
        };
        if (succeeded) {
          await tx.deploymentInstanceNode.updateMany({
            where: { ...rank, claimHeld: true },
            data: { claimHeld: false, stoppedAt: new Date() },
          });
          // The stop's status check proved the service stopped: resources released without
          // that proof (an inactive owner's cancelled interactive stop) are free again.
          await tx.deploymentInstanceNode.updateMany({
            where: { ...rank, heldUnknownSince: { not: null } },
            data: { heldUnknownSince: null },
          });
          await this.settleStopped(tx, step.instanceId);
        } else if (
          // A stop that only checked a held-unknown rank (claim already released) leaves the
          // instance as it is; the rank stays held and the check is retried.
          await tx.deploymentInstanceNode.count({ where: { ...rank, claimHeld: true } })
        ) {
          await tx.deploymentInstance.update({
            where: { id: step.instanceId },
            data: { observedState: "STOP_PENDING" },
          });
        }
      } else if (step.phase === "health") {
        await this.health(tx, step.instanceId, succeeded);
      } else if (!succeeded) {
        await this.gangStop(tx, step.instanceId, "startup_failed");
      } else if (
        step.phase === "readiness" &&
        step.Instance.desiredState === "RUNNING" &&
        ["PENDING", "STARTING"].includes(step.Instance.observedState) &&
        Math.floor(step.sequence / 10) === step.Instance.restartAttempts
      ) {
        const unfinished = await tx.deploymentStep.count({
          where: {
            instanceId: step.instanceId,
            phase: { in: ["prepare", "start", "after_join", "readiness"] },
            sequence: {
              gte: step.Instance.restartAttempts * 10,
              lt: (step.Instance.restartAttempts + 1) * 10,
            },
            state: { not: "SUCCEEDED" },
          },
        });
        if (!unfinished) {
          await tx.deploymentInstance.update({
            where: { id: step.instanceId },
            data: {
              observedState: "RUNNING",
              lastHealthAt: new Date(),
              healthFailures: 0,
              healthSuccesses: 1,
            },
          });
          await tx.endpoint.updateMany({
            where: { deploymentInstanceId: step.instanceId },
            data: { published: true, status: "ONLINE", unpublishedAt: null },
          });
          await tx.discoveredModel.updateMany({
            where: { Endpoint: { deploymentInstanceId: step.instanceId } },
            data: { published: true, unpublishedAt: null },
          });
          await this.attachMembers(tx, step.instanceId);
          await tx.poolMember.updateMany({
            where: memberWhere(step.instanceId),
            data: { instanceGate: "OPEN", routingStatus: "ACTIVE" },
          });
        }
      }
      return true;
    });
  }
  /**
   * Operator progress for an interactive step of the current dispatch (the session
   * manager forwards only frames matching its tracker; the stored terminal id fences a
   * replaced or closed terminal here too):
   * - `awaiting_operator`: the confirm screen is up (again, after a failed run) and waits
   *   for a person: AWAITING_OPERATOR, no deadline, open time kept per terminal.
   * - `operator_running`: the person pressed Enter: RUNNING with the job's deadline.
   * - `operator_closed`: see {@link operatorClosed}.
   */
  private async operatorProgress(tx: Tx, step: StepRow, result: DeploymentJobResult) {
    if (!step.operatorTerminalId || result.terminalId !== step.operatorTerminalId) return false;
    if (result.status === "operator_closed")
      return this.operatorClosed(tx, step, {
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        ...(result.error ? { error: result.error } : {}),
      });
    const where = {
      id: step.id,
      state: step.state,
      ownerEpoch: step.ownerEpoch,
      intentHash: step.intentHash,
      operatorTerminalId: step.operatorTerminalId,
    };
    const now = new Date();
    if (result.status === "awaiting_operator") {
      if (step.state === "AWAITING_OPERATOR") return true;
      const changed = await tx.deploymentStep.updateMany({
        where,
        data: {
          state: "AWAITING_OPERATOR",
          deadline: null,
          leaseExpiresAt: null,
          operatorSince: step.operatorSince ?? now,
        },
      });
      if (!changed.count) return false;
    } else {
      // A repeat, or a run reported before its screen (the session manager drops those).
      if (step.state !== "AWAITING_OPERATOR") return step.operatorSince !== null;
      const { timeoutMs } = intentSchema.parse(step.intent);
      const changed = await tx.deploymentStep.updateMany({
        where,
        data: {
          state: "RUNNING",
          deadline: new Date(now.getTime() + timeoutMs),
          leaseExpiresAt: new Date(now.getTime() + timeoutMs),
          operatorAcceptedAt: now,
        },
      });
      if (!changed.count) return false;
    }
    await this.syncNeedsOperator(tx, step.instanceId);
    return true;
  }
  /**
   * The operator terminal ended without success (declined, closed, cancelled, the node's
   * switch turned off, or it never opened: `error` set). The step keeps waiting for its
   * person with no terminal (reopenable from the dashboard, which resets it to PENDING);
   * claims stay held. Nothing is retried automatically, so a node that cannot open a
   * terminal never loops. A decline (nothing ever ran) is not an attempt.
   */
  private async operatorClosed(
    tx: Tx,
    step: StepRow,
    closed: { exitCode?: number; error?: string },
  ) {
    const changed = await tx.deploymentStep.updateMany({
      where: {
        id: step.id,
        state: step.state,
        ownerEpoch: step.ownerEpoch,
        intentHash: step.intentHash,
        operatorTerminalId: step.operatorTerminalId,
      },
      data: {
        state: "AWAITING_OPERATOR",
        deadline: null,
        leaseExpiresAt: null,
        operatorTerminalId: null,
        operatorSince: step.operatorSince ?? new Date(),
        ...(closed.exitCode !== undefined ? { operatorLastExit: closed.exitCode } : {}),
        ...(closed.error ? { errorCode: closed.error } : {}),
        ...(closed.exitCode === undefined && step.operatorAcceptedAt === null
          ? { attempts: Math.max(0, step.attempts - 1) }
          : {}),
      },
    });
    if (!changed.count) return false;
    await this.syncNeedsOperator(tx, step.instanceId);
    return true;
  }
  /**
   * `needsOperator`: STEP while a step of the instance waits for a person (or a person's run
   * is past its timeout), else RESTART while an interactive start stopped and waits for a
   * person's restart; see {@link syncDeploymentOperatorNeed}.
   */
  private syncNeedsOperator(tx: Tx, instanceId: string) {
    return syncDeploymentOperatorNeed(tx, instanceId);
  }
  /**
   * End a waiting interactive step the reconciler cancels (FAILED with `code`): its terminal
   * is closed by step id first. A terminal whose command already runs is left alone and the
   * step kept (its answer settles it; the CLI holds any stop behind it), so a person's run
   * is never cut off and no `cancelled` row is written for it (§12h L6). Returns whether the
   * step ended. A waiting step whose open terminal the session manager did not close (it
   * had already closed, or its session is gone) is audited `cancelled` here.
   */
  private async cancelOperatorStep(tx: Tx, step: StepRow, code: string, userId: string) {
    const closed = this.transport.closeOperatorStep?.(step.id, { keepRunning: true });
    if (closed === "running") return false;
    const changed = await tx.deploymentStep.updateMany({
      where: { id: step.id, state: step.state, ownerEpoch: step.ownerEpoch },
      data: { state: "FAILED", deadline: null, leaseExpiresAt: null, errorCode: code },
    });
    if (!changed.count) return false;
    const action = operatorAction(step.intent);
    if (step.state === "AWAITING_OPERATOR" && closed !== "closed" && action)
      recordDeploymentOperatorEvent({
        userId,
        instanceId: step.instanceId,
        stepId: step.id,
        cliDeviceId: step.cliDeviceId,
        rank: step.rank,
        action,
        outcome: "cancelled",
      });
    return true;
  }
  /**
   * The instance no longer starts (gang stop, desired stop, a newer generation): end its
   * waiting interactive start steps (AWAITING_OPERATOR, or RUNNING with a terminal that has
   * not drawn its screen yet) and close their terminals, so none outlives the instance's
   * stop or keeps `needsOperator` (chunk 7 review, probe C). A person's run in progress is
   * left to answer; the CLI holds the instance's stop behind it.
   */
  private async settleOperatorStarts(tx: Tx, instanceId: string, code: string) {
    const steps = await tx.deploymentStep.findMany({
      where: {
        instanceId,
        phase: { notIn: ["stop", "health"] },
        OR: [{ state: "AWAITING_OPERATOR" }, { state: "RUNNING", operatorSince: null }],
      },
      include: { Instance: { select: { userId: true } } },
    });
    let settled = false;
    for (const step of steps) {
      if (!operatorFlags(step.intent).interactive) continue;
      if (await this.cancelOperatorStep(tx, step, code, step.Instance.userId)) settled = true;
    }
    if (settled) await this.syncNeedsOperator(tx, instanceId);
  }
  /**
   * Return an interactive step to PENDING so it is dispatched again with a fresh terminal
   * (the CLI checks status first). Its terminal, if any, is closed first by step id (the
   * reset drops the stored id); a terminal whose command already runs is left alone and
   * the step kept, so one step never has two runs (§12h L1). Not counted as an attempt.
   */
  private async reissueOperatorStep(tx: Tx, step: StepRow, instance: InstanceRow) {
    // Closed before the guarded update: should that update match nothing, the CLI's
    // `operator_closed` leaves the step waiting with no terminal, a safe default.
    if (this.transport.closeOperatorStep?.(step.id, { keepRunning: true }) === "running")
      return false;
    // Only a step that is still the one to run goes back to the queue; a step a gang stop,
    // restart or newer stop replaced ends instead of coming back in a later generation.
    const current = await this.operatorStepCurrent(tx, step, instance);
    const changed = await tx.deploymentStep.updateMany({
      where: { id: step.id, state: step.state, ownerEpoch: step.ownerEpoch },
      data: current
        ? {
            state: "PENDING",
            ownerEpoch: null,
            deadline: null,
            leaseExpiresAt: null,
            attempts: Math.max(0, step.attempts - 1),
          }
        : {
            state: "FAILED",
            deadline: null,
            leaseExpiresAt: null,
            errorCode: OPERATOR_SUPERSEDED,
          },
    });
    if (!changed.count) return false;
    await this.syncNeedsOperator(tx, step.instanceId);
    return true;
  }
  /** Whether the step is still the instance's step to run: see {@link reissueOperatorStep}. */
  private async operatorStepCurrent(tx: Tx, step: StepRow, instance: InstanceRow) {
    if (step.phase === "stop") {
      const latest = await tx.deploymentStep.findFirst({
        where: { instanceId: step.instanceId, rank: step.rank, phase: "stop" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true },
      });
      const start = await tx.deploymentStep.findFirst({
        where: { instanceId: step.instanceId, rank: step.rank, phase: "start" },
        orderBy: [{ sequence: "desc" }, { id: "desc" }],
        select: { createdAt: true },
      });
      return latest?.id === step.id && !(start && step.createdAt < start.createdAt);
    }
    return (
      Math.floor(step.sequence / 10) === instance.restartAttempts &&
      instance.desiredState === "RUNNING" &&
      ["PENDING", "STARTING"].includes(instance.observedState)
    );
  }
  /**
   * Why an interactive step may not open its terminal now (`null`: it may): the session has
   * no room, or (non-stop steps; stops are exempt so they are never starved, and open on
   * every node at once, §11.2) the node already has {@link OPERATOR_TERMINALS_PER_NODE} live
   * operator terminals, or it is not its turn ("wait", no reason recorded): another
   * interactive step of the instance's current generation is waiting or running, or one of
   * the same sequence has a lower rank, so a person answers one terminal at a time in recipe
   * order.
   */
  private async operatorHold(
    tx: Tx,
    step: StepRow,
    socket: DeploymentLiveSocket,
    instance: InstanceRow,
  ): Promise<string | null> {
    if (socket.operatorRoom === false) return OPERATOR_HOLD.sessionFull;
    if (step.phase === "stop") return null;
    const live = await tx.deploymentStep.count({
      where: {
        cliDeviceId: step.cliDeviceId,
        phase: { not: "stop" },
        state: { in: ["RUNNING", "AWAITING_OPERATOR"] },
        operatorTerminalId: { not: null },
      },
    });
    if (live >= OPERATOR_TERMINALS_PER_NODE) return OPERATOR_HOLD.nodeFull;
    const others = await tx.deploymentStep.findMany({
      where: {
        instanceId: step.instanceId,
        id: { not: step.id },
        phase: { not: "stop" },
        sequence: {
          gte: instance.restartAttempts * 10,
          lt: (instance.restartAttempts + 1) * 10,
        },
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
    return others.some(
      (other) => other.state !== "PENDING" || operatorFlags(other.intent).interactive,
    )
      ? "wait"
      : null;
  }
  /** Record (once) why a PENDING interactive step is held; see {@link OPERATOR_HOLD}. */
  private async recordOperatorHold(tx: Tx, step: StepRow, reason: string) {
    // The hold itself (`operatorHold`) is always recorded: the step needs its person, and the
    // instance raises `needsOperator` (badge, notice, email; security review L1), also for a
    // stop whose `errorCode` keeps its gang-stop reason.
    const holdChanged = step.operatorHold !== reason;
    // A held-unknown status check's marker gives way too, so its wait has a reason (review
    // L1); the probe stays identifiable by its sequence.
    const codeChanges =
      step.errorCode !== reason &&
      (step.errorCode === null ||
        step.errorCode === HELD_UNKNOWN_PROBE ||
        OPERATOR_HOLD_CODES.includes(step.errorCode));
    if (!holdChanged && !codeChanges) return;
    await tx.deploymentStep.updateMany({
      where: { id: step.id, state: "PENDING" },
      data: { operatorHold: reason, ...(codeChanges ? { errorCode: reason } : {}) },
    });
    if (holdChanged) await this.syncNeedsOperator(tx, step.instanceId);
  }
  /**
   * A person's command runs in an operator terminal for this instance on this node, in the
   * current session (`operator_running` seen). The CLI holds any stop for the instance until
   * that run ends (design §12g M1), so a stop waits for it rather than time out unanswered.
   */
  private async operatorRunHolds(tx: Tx, step: StepRow, ownerEpoch: string) {
    return (
      (await tx.deploymentStep.count({
        where: {
          instanceId: step.instanceId,
          cliDeviceId: step.cliDeviceId,
          id: { not: step.id },
          state: "RUNNING",
          operatorSince: { not: null },
          ownerEpoch,
        },
      })) > 0
    );
  }
  acceptInventory(socket: DeploymentSocket, instances: DeploymentObservedInstance[]) {
    if (this.stopped || !this.current(socket)) return Promise.resolve(false);
    return this.track(
      (async () => {
        if (!(await this.db.$transaction((tx) => this.fenceSocket(tx, socket)))) return false;
        for (const observed of instances) {
          if (!this.current(socket)) return false;
          await this.locked(socket.userId, observed.instanceId, async (tx) => {
            if (!(await this.fenceSocket(tx, socket))) return;
            const node = await tx.deploymentInstanceNode.findFirst({
              where: {
                instanceId: observed.instanceId,
                rank: observed.rank,
                cliDeviceId: socket.cliDeviceId,
                Instance: { userId: socket.userId },
              },
              include: { Instance: true },
            });
            if (
              !node ||
              node.Instance.revisionId !== observed.revisionId ||
              node.port !== observed.port ||
              node.Instance.endpointSlug !== observed.endpointSlug ||
              observed.unitName !== `wsmp-i-${observed.instanceId}-r${observed.rank}`
            )
              return;
            const step = observed.stepId
              ? await tx.deploymentStep.findFirst({
                  where: {
                    id: observed.stepId,
                    instanceId: observed.instanceId,
                    cliDeviceId: socket.cliDeviceId,
                    rank: observed.rank,
                    intentHash: observed.intentHash,
                  },
                })
              : null;
            if (!step) return; // Hashes are per-step, never compare readiness against start.
            if (observed.phase === "stopped") {
              const latestStop = await tx.deploymentStep.findFirst({
                where: { instanceId: node.instanceId, rank: node.rank, phase: "stop" },
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              });
              const latestStart = await tx.deploymentStep.findFirst({
                where: { instanceId: node.instanceId, rank: node.rank, phase: "start" },
                orderBy: [{ sequence: "desc" }, { id: "desc" }],
              });
              if (
                latestStop?.id !== step.id ||
                (latestStart && step.createdAt < latestStart.createdAt)
              )
                return;
              // A verified reconnect observation can settle only the exact durable stop. It is
              // also the status proof a held-unknown rank waits for (its cancelled stop).
              const heldUnknown = !node.claimHeld && node.heldUnknownSince !== null;
              if (
                step.phase !== "stop" ||
                (!heldUnknown &&
                  !["STOPPING", "STOP_PENDING"].includes(node.Instance.observedState)) ||
                !["RUNNING", "FAILED"].includes(step.state)
              )
                return;
              const settled = await tx.deploymentStep.updateMany({
                where: { id: step.id, state: { in: ["RUNNING", "FAILED"] } },
                data: { state: "SUCCEEDED", leaseExpiresAt: null },
              });
              if (!settled.count) return;
              await tx.deploymentInstanceNode.updateMany({
                where: { id: node.id, claimHeld: true },
                data: { claimHeld: false, stoppedAt: new Date() },
              });
              await tx.deploymentInstanceNode.updateMany({
                where: { id: node.id, heldUnknownSince: { not: null } },
                data: { heldUnknownSince: null },
              });
              await this.settleStopped(tx, node.instanceId);
            } else if (
              observed.phase === "ready" &&
              ["start", "prepare", "after_join", "readiness"].includes(step.phase)
            ) {
              if (Math.floor(step.sequence / 10) !== node.Instance.restartAttempts) return;
              await tx.deploymentStep.updateMany({
                where: { id: step.id, state: { in: ["RUNNING", "FAILED"] } },
                data: { state: "SUCCEEDED", leaseExpiresAt: null, errorCode: null },
              });
              if (node.Instance.desiredState === "STOPPED")
                await this.gangStop(tx, node.instanceId, "desired_stop");
            } else if (observed.phase === "unhealthy") {
              // The CLI's phase becomes unhealthy at its failure threshold and stays so until
              // its success threshold, while the observed step is simply its latest health job
              // (whatever that job's own outcome). So this is threshold evidence for the
              // instance, never the outcome of the observed step. Accept it only for the latest
              // health step of the current start, so it cannot override newer evidence.
              if (step.phase !== "health") return;
              const latestStart = await tx.deploymentStep.findFirst({
                where: { instanceId: node.instanceId, rank: node.rank, phase: "start" },
                orderBy: [{ sequence: "desc" }, { id: "desc" }],
              });
              if (latestStart && step.createdAt < latestStart.createdAt) return;
              const latestHealth = await tx.deploymentStep.findFirst({
                where: { instanceId: node.instanceId, phase: "health" },
                orderBy: [{ sequence: "desc" }, { id: "desc" }],
                select: { id: true },
              });
              if (latestHealth?.id !== step.id) return;
              // A result dispatched to an earlier session can no longer be accepted; settle it
              // so its deadline does not count it again. A current-session result is in flight.
              if (step.ownerEpoch !== `${this.epoch}:${socket.generation}`)
                await tx.deploymentStep.updateMany({
                  where: { id: step.id, state: "RUNNING" },
                  data: { state: "FAILED", errorCode: "result_lost", leaseExpiresAt: null },
                });
              await this.observedUnhealthy(tx, node.instanceId);
            }
          });
        }
        // The session marks itself inventory-complete only after this resolves true.
        return this.current(socket);
      })(),
    ).finally(() => this.wake());
  }
  private async attachMembers(tx: Tx, instanceId: string) {
    const instance = await tx.deploymentInstance.findUniqueOrThrow({
      where: { id: instanceId },
      include: { Config: true, Revision: true },
    });
    const variant = storedDeploymentSpecSchema
      .parse(instance.Revision.spec)
      .variants.find((v) => v.key === instance.variantKey);
    if (!variant) throw new Error("deployment_variant_missing");
    // Pool deletion detaches only recipes without live instances, so this never happens.
    const poolId = instance.Config.poolId;
    if (!poolId) throw new Error("deployment_pool_detached");
    const models = await tx.discoveredModel.findMany({
      where: {
        Endpoint: { deploymentInstanceId: instanceId },
        // The relay stores reported ids trimmed; match the revision in that form.
        upstreamModelId: { in: variant.models.map((model) => model.trim()) },
      },
      include: { ExecutionTarget: true },
    });
    for (const model of models) {
      if (!model.ExecutionTarget) continue;
      if (model.ExecutionTarget.inferenceCapacityId)
        await tx.inferenceCapacity.update({
          where: { id: model.ExecutionTarget.inferenceCapacityId },
          data: {
            hardConcurrencyLimit: variant.hardConcurrencyLimit,
            hardConcurrencyLimitSource: "USER",
            physicalMaxContext: variant.contextWindow,
          },
        });
      await tx.poolMember.upsert({
        where: {
          poolId_executionTargetId: {
            poolId,
            executionTargetId: model.ExecutionTarget.id,
          },
        },
        create: {
          poolId,
          executionTargetId: model.ExecutionTarget.id,
          discoveredModelId: model.id,
          tier: "PRIMARY",
          instanceGate: "CLOSED",
          weight: variant.weight,
          capacityContextCeilingMode: variant.contextWindow ? "LIMITED" : "INHERIT",
          capacityContextCeiling: variant.contextWindow,
        },
        update: {
          instanceGate: "CLOSED",
          weight: variant.weight,
          capacityContextCeilingMode: variant.contextWindow ? "LIMITED" : "INHERIT",
          capacityContextCeiling: variant.contextWindow,
        },
      });
    }
  }
  private async healthSubject(tx: Tx, instanceId: string) {
    const instance = await tx.deploymentInstance.findUniqueOrThrow({
      where: { id: instanceId },
      include: { Revision: true },
    });
    if (
      instance.desiredState !== "RUNNING" ||
      !["RUNNING", "UNHEALTHY"].includes(instance.observedState)
    )
      return null;
    const variant = storedDeploymentSpecSchema
      .parse(instance.Revision.spec)
      .variants.find((v) => v.key === instance.variantKey);
    return variant ? { instance, variant } : null;
  }
  private async health(tx: Tx, instanceId: string, success: boolean) {
    const subject = await this.healthSubject(tx, instanceId);
    if (!subject) return;
    const { instance, variant } = subject;
    const failures = success ? 0 : instance.healthFailures + 1;
    const successes = success ? instance.healthSuccesses + 1 : 0;
    const healthy = success && successes >= variant.health.successThreshold;
    const unhealthy = !success && failures >= variant.health.failureThreshold;
    await tx.deploymentInstance.update({
      where: { id: instanceId },
      data: {
        lastHealthAt: new Date(),
        healthFailures: failures,
        healthSuccesses: successes,
        ...(healthy
          ? { observedState: "RUNNING" }
          : unhealthy
            ? { observedState: "UNHEALTHY" }
            : {}),
      },
    });
    if (healthy || unhealthy) await this.publishHealth(tx, instanceId, healthy);
  }
  /**
   * A current CLI observation crossed the failure threshold. Persist the transition like the
   * threshold-crossing job result; only fresh successful health results reopen the member.
   * Repeated snapshots are no-ops: they neither recount nor postpone the next health check
   * (`lastHealthAt` belongs to actual results).
   */
  private async observedUnhealthy(tx: Tx, instanceId: string) {
    const subject = await this.healthSubject(tx, instanceId);
    if (subject?.instance.observedState !== "RUNNING") return;
    const { instance, variant } = subject;
    await tx.deploymentInstance.update({
      where: { id: instanceId },
      data: {
        observedState: "UNHEALTHY",
        healthFailures: Math.max(instance.healthFailures, variant.health.failureThreshold),
        healthSuccesses: 0,
      },
    });
    await this.publishHealth(tx, instanceId, false);
  }
  private async publishHealth(tx: Tx, instanceId: string, healthy: boolean) {
    await tx.poolMember.updateMany({
      where: memberWhere(instanceId),
      data: { instanceGate: healthy ? "OPEN" : "CLOSED" },
    });
    // A passing check never republishes an endpoint whose last inventory was refused.
    const endpoint = healthy
      ? {
          deploymentInstanceId: instanceId,
          OR: [
            { failureReasonCode: null },
            { failureReasonCode: { not: MANAGED_IDENTITY_REFUSED } },
          ],
        }
      : { deploymentInstanceId: instanceId };
    await tx.endpoint.updateMany({
      where: endpoint,
      data: {
        published: healthy,
        status: healthy ? "ONLINE" : "DEGRADED",
        unpublishedAt: healthy ? null : new Date(),
      },
    });
    await tx.discoveredModel.updateMany({
      where: { Endpoint: endpoint },
      data: { published: healthy, unpublishedAt: healthy ? null : new Date() },
    });
  }
  /**
   * After a confirmed stop: once no rank holds its claim, the instance is STOPPED and leaves
   * routing, its waiting starts end, and its operator need follows (RESTART for an
   * interactive start that should run). A FAILED instance (a held-unknown status check after
   * its restarts ran out) stays FAILED.
   */
  private async settleStopped(tx: Tx, instanceId: string) {
    const held = await tx.deploymentInstanceNode.count({ where: { instanceId, claimHeld: true } });
    if (held) return;
    await tx.deploymentInstance.updateMany({
      where: { id: instanceId, observedState: { notIn: ["STOPPED", "FAILED"] } },
      data: { observedState: "STOPPED" },
    });
    await tx.poolMember.updateMany({
      where: memberWhere(instanceId),
      data: { instanceGate: "CLOSED", routingStatus: "DISABLED" },
    });
    await this.settleOperatorStarts(tx, instanceId, OPERATOR_SUPERSEDED);
    await this.syncNeedsOperator(tx, instanceId);
  }
  /**
   * Stop every held rank of the instance (startup failure, deadline, node offline, desired
   * stop seen in inventory, inactive owner). An interactive stop waits for its person with the
   * claims held (§11). An instance whose start is interactive is never restarted
   * automatically: once its stops settle it waits with `needsOperator=RESTART` for a person's
   * restart (design §4).
   */
  private async gangStop(tx: Tx, instanceId: string, code: string) {
    const instance = await tx.deploymentInstance.findUniqueOrThrow({
      where: { id: instanceId },
      include: { Nodes: { where: { claimHeld: true } } },
    });
    const operatorStart = await deploymentStartsInteractive(tx, instanceId);
    await tx.deploymentInstance.update({
      where: { id: instanceId },
      data: {
        // Without held claims nothing can still be running, so there is nothing to stop.
        observedState: instance.Nodes.length ? "STOP_PENDING" : "STOPPED",
        ...(instance.desiredState === "RUNNING"
          ? {
              nextRestartAt: operatorStart
                ? null
                : new Date(Date.now() + (BACKOFF[instance.restartAttempts] ?? 300_000)),
            }
          : {}),
      },
    });
    await tx.poolMember.updateMany({
      where: memberWhere(instanceId),
      data: { instanceGate: "CLOSED", routingStatus: "DRAINING" },
    });
    await tx.endpoint.updateMany({
      where: { deploymentInstanceId: instanceId },
      data: { published: false, unpublishedAt: new Date() },
    });
    await tx.deploymentStep.updateMany({
      where: { instanceId, phase: { not: "stop" }, state: "PENDING" },
      data: { state: "FAILED", errorCode: code },
    });
    // Waiting start terminals end with the start they belong to (design §4).
    await this.settleOperatorStarts(tx, instanceId, code);
    for (const node of instance.Nodes) {
      const start = await tx.deploymentStep.findFirst({
        where: { instanceId, rank: node.rank, phase: "start" },
        orderBy: [{ sequence: "desc" }, { id: "desc" }],
      });
      if (!start) continue;
      const currentStops = {
        instanceId,
        rank: node.rank,
        phase: "stop",
        createdAt: { gte: start.createdAt },
      };
      // A stop waiting for its person is live too: never a second stop beside it.
      const activeStop = await tx.deploymentStep.findFirst({
        where: { ...currentStops, state: { in: [...LIVE_STEP_STATES] } },
      });
      if (activeStop) continue;
      const priorStops = await tx.deploymentStep.count({ where: currentStops });
      if (priorStops >= 3) continue;
      const stopIntent = originalDeploymentStopIntent(start.intent);
      await tx.deploymentStep.create({
        data: {
          runId: instance.runId,
          instanceId,
          cliDeviceId: node.cliDeviceId,
          rank: node.rank,
          phase: "stop",
          sequence: 100 + instance.restartAttempts * 10 + priorStops,
          intent: stopIntent,
          intentHash: deploymentFingerprint(stopIntent),
          errorCode: code,
        },
      });
    }
    await this.syncNeedsOperator(tx, instanceId);
  }
  private async tick() {
    const rows = await this.db.deploymentStep.findMany({
      where: {
        state: { in: ["PENDING", "RUNNING", "AWAITING_OPERATOR"] },
        ...(this.stepCursor
          ? {
              OR: [
                { updatedAt: { gt: this.stepCursor.updatedAt } },
                { updatedAt: this.stepCursor.updatedAt, id: { gt: this.stepCursor.id } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        updatedAt: true,
        instanceId: true,
        cliDeviceId: true,
        state: true,
        Instance: { select: { userId: true } },
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: BATCH,
    });
    const lastStep = rows.at(-1);
    this.stepCursor = lastStep ? { updatedAt: lastStep.updatedAt, id: lastStep.id } : null;
    for (const row of rows) {
      if (this.stopped) return;
      // Without a session for its node a step can change only if it waits for a person (a
      // superseded waiting step ends); skip the others without a transaction.
      if (row.state !== "AWAITING_OPERATOR" && !this.transport.current(row.cliDeviceId)) continue;
      const dispatch = await this.locked(row.Instance.userId, row.instanceId, async (tx) => {
        const step = await tx.deploymentStep.findUnique({
          where: { id: row.id },
          include: { Instance: { include: { Nodes: true } } },
        });
        if (!step || !["PENDING", "RUNNING", "AWAITING_OPERATOR"].includes(step.state)) return null;
        const instance = step.Instance;
        // A waiting step that is no longer the one to run (its instance stopped or restarted,
        // a newer stop replaced it) ends, also while its node is away: it must not keep its
        // instance's need or its claims' wait alive (chunk 7 review, probe C).
        if (
          step.state === "AWAITING_OPERATOR" &&
          !(await this.operatorStepCurrent(tx, step, instance))
        ) {
          if (await this.cancelOperatorStep(tx, step, OPERATOR_SUPERSEDED, instance.userId))
            await this.syncNeedsOperator(tx, instance.id);
          return null;
        }
        const socket = this.transport.current(step.cliDeviceId);
        if (!socket || socket.userId !== instance.userId || !socket.inventoryComplete) return null;
        const ownerEpoch = `${this.epoch}:${socket.generation}`;
        const operator = operatorFlags(step.intent);
        if (step.state === "AWAITING_OPERATOR") {
          // No wall-clock deadline: it waits for its person, claims held (§11.3). A terminal
          // that ended with an earlier session (reconnect, server restart) is opened afresh;
          // a closed one waits for its person to reopen it.
          if (step.ownerEpoch !== ownerEpoch && step.operatorTerminalId !== null)
            await this.reissueOperatorStep(tx, step, instance);
          return null;
        }
        if (step.state === "RUNNING" && operator.interactive) {
          const overdue = !!step.deadline && step.deadline.getTime() <= Date.now();
          // The session that held its terminal (and any run in it) ended: dispatch afresh.
          if (step.ownerEpoch !== ownerEpoch) await this.reissueOperatorStep(tx, step, instance);
          // The spawn deadline: no confirm screen in time.
          else if (step.operatorSince === null) {
            if (overdue) await this.reissueOperatorStep(tx, step, instance);
          }
          // A person's run in this session is never cut off or re-sent; the CLI answers when
          // its terminal ends (§12h L1). Past its timeout it needs its person again.
          else if (overdue) await this.syncNeedsOperator(tx, instance.id);
          return null;
        }
        if (step.state === "RUNNING") {
          if (!step.deadline || step.deadline.getTime() > Date.now()) return null;
          if (step.phase === "stop" && (await this.operatorRunHolds(tx, step, ownerEpoch))) {
            // Held by the CLI behind a person's run: re-send once it ends; never fail it or
            // release its claims, and do not count the wait as an attempt.
            await tx.deploymentStep.updateMany({
              where: { id: step.id, state: "RUNNING", ownerEpoch: step.ownerEpoch },
              data: {
                state: "PENDING",
                ownerEpoch: null,
                deadline: null,
                leaseExpiresAt: null,
                attempts: Math.max(0, step.attempts - 1),
              },
            });
          } else if (step.phase === "stop" && step.attempts < 3) {
            await tx.deploymentStep.update({
              where: { id: step.id },
              data: { state: "PENDING", ownerEpoch: null, leaseExpiresAt: null },
            });
          } else if (step.phase === "health") {
            await tx.deploymentStep.update({
              where: { id: step.id },
              data: { state: "FAILED", errorCode: "job_deadline", leaseExpiresAt: null },
            });
            await this.health(tx, instance.id, false);
          } else if (step.phase === "stop") {
            await tx.deploymentStep.update({
              where: { id: step.id },
              data: { state: "FAILED", errorCode: "job_deadline", leaseExpiresAt: null },
            });
            await tx.deploymentInstance.update({
              where: { id: instance.id },
              data: { observedState: "STOP_PENDING" },
            });
          } else {
            await tx.deploymentStep.update({
              where: { id: step.id },
              data: { state: "FAILED", errorCode: "job_deadline", leaseExpiresAt: null },
            });
            await this.gangStop(tx, instance.id, "job_deadline");
          }
          return null;
        }
        // Never claim a step the node cannot run (§12c): a refused send would loop every tick.
        if (
          (operator.interactive || operator.stopInteractive) &&
          socket.deploymentOperator !== true
        ) {
          await this.recordOperatorHold(tx, step, OPERATOR_HOLD.unsupported);
          return null;
        }
        if (step.phase !== "stop" && instance.desiredState !== "RUNNING") return null;
        if (
          step.phase !== "stop" &&
          (instance.observedState === "STOP_PENDING" || instance.observedState === "STOPPING")
        )
          return null;
        if (step.notBefore && step.notBefore.getTime() > Date.now()) {
          if (step.phase !== "stop") return null;
          const targets = await tx.executionTarget.findMany({
            where: { DiscoveredModel: { Endpoint: { deploymentInstanceId: instance.id } } },
            select: { id: true },
          });
          const live = await tx.capacityLease.count({
            where: {
              state: "ACTIVE",
              expiresAt: { gt: new Date() },
              executionTargetId: { in: targets.map((t) => t.id) },
            },
          });
          if (live) return null;
        }
        if (step.phase !== "stop" && step.phase !== "health") {
          // Never a step of another restart generation (earlier ones end with their gang stop).
          if (Math.floor(step.sequence / 10) !== instance.restartAttempts) return null;
          const lower = await tx.deploymentStep.count({
            where: {
              instanceId: instance.id,
              sequence: { gte: instance.restartAttempts * 10, lt: step.sequence },
              phase: { not: "stop" },
              state: { not: "SUCCEEDED" },
            },
          });
          if (lower) return null;
          const blockers = instance.Nodes.flatMap((n) => n.blockedBy);
          if (
            blockers.length &&
            (await tx.deploymentInstanceNode.count({
              where: { instanceId: { in: blockers }, claimHeld: true },
            }))
          )
            return null;
        }
        const device = await tx.cliDevice.findFirst({
          where: {
            id: step.cliDeviceId,
            userId: instance.userId,
            connectionGeneration: socket.generation,
            status: "CONNECTED",
          },
        });
        if (!device?.allowDeployments || !device.reportedDeployments) return null;
        const plan = await tx.deploymentPlan.findFirst({ where: { Run: { id: step.runId } } });
        if (!plan) return null;
        const affected = z
          .object({ affectedNodeIds: z.array(z.string()).max(4096) })
          .safeParse(plan.contents);
        if (!affected.success) return null;
        const affectedDevices = await tx.cliDevice.findMany({
          where: { id: { in: affected.data.affectedNodeIds }, userId: instance.userId },
        });
        if (
          affectedDevices.length !== new Set(affected.data.affectedNodeIds).size ||
          affectedDevices.some((d) => !d.allowDeployments || !d.reportedDeployments)
        )
          return null;
        const commandActor = deploymentCommandActor(plan);
        if (commandActor === "AGENT") {
          if (
            affectedDevices.some(
              (d) =>
                d.mcpCommandMode === "OFF" ||
                !d.reportedMcpCommandMode ||
                d.reportedMcpCommandMode === "OFF" ||
                (!plan.confirmedAt &&
                  (d.mcpCommandMode !== "UNSUPERVISED" ||
                    d.reportedMcpCommandMode !== "UNSUPERVISED")),
            )
          )
            return null;
        }
        if (!(await this.fenceSocket(tx, socket))) return null;
        if (step.phase !== "stop" && instance.Nodes.some((node) => !node.claimHeld)) return null;
        if (
          step.phase !== "stop" &&
          !(await deploymentExecutionAllowed(tx, instance.userId, instance.id, step.runId))
        )
          return null;
        if (operator.interactive) {
          // A banned or deleting owner's terminal could never be answered (stops are otherwise
          // dispatched for inactive owners; starts never are): the drain cancels it instead.
          if (!(await this.ownerActive(tx, instance.userId))) return null;
          const hold = await this.operatorHold(tx, step, socket, instance);
          if (hold === "wait") return null;
          if (hold) {
            await this.recordOperatorHold(tx, step, hold);
            return null;
          }
        }
        // A stop sent now would be held by the CLI behind a person's run; send it after.
        if (step.phase === "stop" && (await this.operatorRunHolds(tx, step, ownerEpoch)))
          return null;
        const intent = intentSchema.parse(step.intent);
        if (deploymentFingerprint(intent) !== step.intentHash)
          throw new Error("deployment_intent_hash_mismatch");
        // A fresh terminal per dispatch (ids are never reused, §12h), with who wrote the command.
        const jobOperator = operator.interactive
          ? await mintDeploymentOperator(tx, instance, { rank: step.rank, action: intent.action })
          : undefined;
        const deadline = new Date(
          Date.now() +
            (jobOperator
              ? Math.min(intent.timeoutMs, OPERATOR_SPAWN_BUDGET_MAX) + OPERATOR_SPAWN_GRACE
              : intent.timeoutMs),
        );
        const claimed = await tx.deploymentStep.updateMany({
          where: { id: step.id, state: "PENDING" },
          data: {
            state: "RUNNING",
            ownerEpoch,
            attempts: { increment: 1 },
            deadline,
            leaseExpiresAt: deadline,
            ...(jobOperator ? { operatorTerminalId: jobOperator.terminalId } : {}),
            ...(step.errorCode && OPERATOR_HOLD_CODES.includes(step.errorCode)
              ? { errorCode: null }
              : {}),
          },
        });
        if (!claimed.count) return null;
        // The claim cleared the hold (schema-hardening.sql): the need follows.
        if (step.operatorHold !== null) await this.syncNeedsOperator(tx, instance.id);
        if (step.phase === "stop") {
          await tx.poolMember.updateMany({
            where: memberWhere(instance.id),
            data: { instanceGate: "CLOSED", routingStatus: "DRAINING" },
          });
        } else if (["prepare", "start"].includes(step.phase)) {
          await tx.deploymentInstance.update({
            where: { id: instance.id },
            data: { observedState: "STARTING" },
          });
        }
        return {
          socket,
          job: {
            ...intent,
            stepId: step.id,
            intentHash: step.intentHash,
            ownerEpoch,
            actor: commandActor,
            humanApproved: commandActor !== "AGENT" || !!plan.confirmedAt,
            ...(jobOperator ? { operator: jobOperator } : {}),
          } satisfies DeploymentJob,
        };
      }).catch(() => {
        console.error("[deployments] step reconciliation failed");
        return null;
      });
      // Durable lease/intention is committed before the first external side effect.
      if (!dispatch) continue;
      const delivered =
        !this.stopped &&
        this.current(dispatch.socket) &&
        this.transport.send(dispatch.socket, dispatch.job);
      if (!delivered) await this.undeliver(row.Instance.userId, row.instanceId, dispatch.job);
    }
    await this.maintenance();
    await this.drainInactiveOwners();
    await this.probeHeldUnknown();
    await this.closeRevokedOperatorTerminals();
    this.emailOperatorNeeds();
    await this.pruneHealthHistory();
  }
  /**
   * Email owners whose deployments wait for them (SMTP only), every
   * {@link NEEDS_EMAIL_INTERVAL_MS}, off the tick's critical path (joined at shutdown).
   */
  private emailOperatorNeeds() {
    const now = Date.now();
    if (now - this.lastNeedsEmailAt < NEEDS_EMAIL_INTERVAL_MS) return;
    this.lastNeedsEmailAt = now;
    void this.track(
      notifyDeploymentOperatorNeeds({
        db: this.db,
        // No claim (and no mail) once the reconciler stops or the DB shutdown fence is armed.
        shouldStop: () => this.stopped || isDbShutdownFenceArmed(),
      }),
    ).catch(() => {
      console.error("[deployments] needs-you notices failed");
    });
  }
  private async ownerActive(tx: Tx, userId: string) {
    const owner = await tx.user.findUnique({
      where: { id: userId },
      select: { banned: true, banExpires: true, deletionRequestedAt: true },
    });
    return !!owner && !userCredentialAccessBlocked(owner, new Date());
  }
  /**
   * Banned or deletion-pending owners (design §12b policy, user decision §12g): their waiting
   * operator steps (start or stop, waiting to open, open or closed) are cancelled (audit
   * `cancelled`, terminals closed), a cancelled start gang-stops its instance, and a rank
   * whose latest stop is a cancelled or failed interactive stop releases its claim, so account
   * deletion is never blocked by a terminal nobody may answer. The service may still run
   * there, so the release keeps the resources held unknown (`heldUnknownSince`): placement
   * and execution budgets count them until a status check proves the service stopped. A
   * person's run already in progress is left to answer. The indefinite hold of §11.3 applies
   * to active owners only.
   */
  private async drainInactiveOwners() {
    const now = new Date();
    const interactive = { path: ["interactive"], equals: true };
    const instances = await this.db.deploymentInstance.findMany({
      where: {
        ...(this.drainCursor ? { id: { gt: this.drainCursor } } : {}),
        User: inactiveOwner(now),
        OR: [
          { Steps: { some: { state: { in: [...LIVE_STEP_STATES] }, intent: interactive } } },
          {
            Nodes: { some: { claimHeld: true } },
            Steps: { some: { phase: "stop", state: "FAILED", intent: interactive } },
          },
        ],
      },
      select: { id: true, userId: true },
      orderBy: { id: "asc" },
      take: BATCH,
    });
    this.drainCursor = instances.at(-1)?.id ?? null;
    for (const row of instances) {
      if (this.stopped) return;
      await this.locked(row.userId, row.id, async (tx) => {
        if (await this.ownerActive(tx, row.userId)) return;
        const instance = await tx.deploymentInstance.findUnique({ where: { id: row.id } });
        if (!instance) return;
        const starts = await tx.deploymentStep.findMany({
          where: {
            instanceId: row.id,
            phase: { not: "stop" },
            state: { in: [...LIVE_STEP_STATES] },
          },
        });
        let startCancelled = false;
        for (const step of starts) {
          if (!operatorFlags(step.intent).interactive) continue;
          if (await this.cancelOperatorStep(tx, step, OWNER_INACTIVE, row.userId))
            startCancelled = true;
        }
        if (
          startCancelled &&
          !["STOP_PENDING", "STOPPING", "STOPPED", "FAILED"].includes(instance.observedState)
        )
          await this.gangStop(tx, row.id, OWNER_INACTIVE);
        const stops = await tx.deploymentStep.findMany({
          where: { instanceId: row.id, phase: "stop", state: { in: [...LIVE_STEP_STATES] } },
        });
        for (const stop of stops)
          if (operatorFlags(stop.intent).interactive)
            await this.cancelOperatorStep(tx, stop, OWNER_INACTIVE, row.userId);
        const held = await tx.deploymentInstanceNode.findMany({
          where: { instanceId: row.id, claimHeld: true },
        });
        let released = false;
        for (const node of held) {
          const latestStop = await tx.deploymentStep.findFirst({
            where: { instanceId: row.id, rank: node.rank, phase: "stop" },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          });
          const latestStart = await tx.deploymentStep.findFirst({
            where: { instanceId: row.id, rank: node.rank, phase: "start" },
            orderBy: [{ sequence: "desc" }, { id: "desc" }],
            select: { createdAt: true },
          });
          if (
            latestStop?.state !== "FAILED" ||
            !operatorFlags(latestStop.intent).interactive ||
            (latestStart && latestStop.createdAt < latestStart.createdAt)
          )
            continue;
          const changed = await tx.deploymentInstanceNode.updateMany({
            where: { id: node.id, claimHeld: true },
            data: { claimHeld: false, stoppedAt: now, heldUnknownSince: now },
          });
          if (changed.count) released = true;
        }
        if (released) await this.settleStopped(tx, row.id);
        else await this.syncNeedsOperator(tx, row.id);
      }).catch(() => {
        console.error("[deployments] inactive owner drain failed");
      });
    }
  }
  /**
   * Resources held unknown (see {@link drainInactiveOwners}) of an owner who is active again
   * need a status check: a stop of the rank (its intent from the rank's latest start), which
   * the CLI settles from status when the service is already stopped, and otherwise opens for
   * the person. Its success frees the resources. One check at a time per rank; a failed or
   * cancelled one is retried after {@link HELD_UNKNOWN_PROBE_RETRY}.
   */
  private async probeHeldUnknown() {
    const nodes = await this.db.deploymentInstanceNode.findMany({
      where: {
        ...(this.probeCursor ? { id: { gt: this.probeCursor } } : {}),
        claimHeld: false,
        heldUnknownSince: { not: null },
        Instance: { User: activeOwner(new Date()) },
      },
      select: { id: true, instanceId: true, Instance: { select: { userId: true } } },
      orderBy: { id: "asc" },
      take: BATCH,
    });
    this.probeCursor = nodes.at(-1)?.id ?? null;
    for (const row of nodes) {
      if (this.stopped) return;
      await this.locked(row.Instance.userId, row.instanceId, async (tx) => {
        if (!(await this.ownerActive(tx, row.Instance.userId))) return;
        const node = await tx.deploymentInstanceNode.findUnique({
          where: { id: row.id },
          include: { Instance: { select: { runId: true } } },
        });
        if (!node || node.claimHeld || node.heldUnknownSince === null) return;
        const start = await tx.deploymentStep.findFirst({
          where: { instanceId: node.instanceId, rank: node.rank, phase: "start" },
          orderBy: [{ sequence: "desc" }, { id: "desc" }],
        });
        if (!start) return;
        const latest = await tx.deploymentStep.findFirst({
          where: { instanceId: node.instanceId, rank: node.rank, phase: "stop" },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        });
        if (latest && (LIVE_STEP_STATES as readonly string[]).includes(latest.state)) return;
        // An earlier check (probe sequences) that failed or was cancelled is retried after a
        // pause; the cancelled stop that released the resources is no check.
        if (
          latest &&
          latest.sequence >= HELD_UNKNOWN_PROBE_SEQUENCE &&
          latest.updatedAt.getTime() > Date.now() - HELD_UNKNOWN_PROBE_RETRY
        )
          return;
        const top = await tx.deploymentStep.aggregate({
          where: { instanceId: node.instanceId, rank: node.rank, phase: "stop" },
          _max: { sequence: true },
        });
        const intent = originalDeploymentStopIntent(start.intent);
        await tx.deploymentStep.create({
          data: {
            runId: node.Instance.runId,
            instanceId: node.instanceId,
            cliDeviceId: node.cliDeviceId,
            rank: node.rank,
            phase: "stop",
            sequence: Math.max(HELD_UNKNOWN_PROBE_SEQUENCE - 1, top._max.sequence ?? 0) + 1,
            intent,
            intentHash: deploymentFingerprint(intent),
            errorCode: HELD_UNKNOWN_PROBE,
          },
        });
      }).catch(() => {
        console.error("[deployments] held resource check failed");
      });
    }
  }
  /**
   * A dashboard grant revocation (`allowDeployments` off) closes the node's waiting operator
   * terminals (design §12h L5); the session manager also does on the grant change, and its
   * attach gate requires the grant. A person's run in progress is left to finish. Repeats are
   * no-ops: a cancelled terminal is not closed twice.
   */
  private async closeRevokedOperatorTerminals() {
    const close = this.transport.closeOperatorStep?.bind(this.transport);
    if (!close) return;
    // Paged by id across ticks (review L4), so every live terminal is examined in turn.
    const steps = await this.db.deploymentStep.findMany({
      where: {
        ...(this.revokedCursor ? { id: { gt: this.revokedCursor } } : {}),
        state: { in: ["RUNNING", "AWAITING_OPERATOR"] },
        operatorTerminalId: { not: null },
      },
      select: { id: true, cliDeviceId: true },
      orderBy: { id: "asc" },
      take: 256,
    });
    this.revokedCursor = steps.length === 256 ? (steps.at(-1)?.id ?? null) : null;
    if (!steps.length) return;
    const revoked = new Set(
      (
        await this.db.cliDevice.findMany({
          where: {
            id: { in: [...new Set(steps.map((s) => s.cliDeviceId))] },
            allowDeployments: false,
          },
          select: { id: true },
        })
      ).map((device) => device.id),
    );
    for (const step of steps)
      if (revoked.has(step.cliDeviceId)) close(step.id, { keepRunning: true });
  }
  /**
   * The CLI provably never received this job (no current socket, a refused
   * send, or the reconciler stopping after the commit): return the step to
   * PENDING under its own owner epoch instead of waiting out its deadline and
   * counting a failed attempt.
   */
  private async undeliver(userId: string, instanceId: string, job: DeploymentJob) {
    // An earlier terminal of the step must not stay open behind the reset (§12h L3).
    if (job.operator) this.transport.closeOperatorStep?.(job.stepId);
    await this.locked(userId, instanceId, (tx) =>
      tx.deploymentStep.updateMany({
        where: { id: job.stepId, state: "RUNNING", ownerEpoch: job.ownerEpoch },
        data: {
          state: "PENDING",
          ownerEpoch: null,
          deadline: null,
          leaseExpiresAt: null,
          attempts: { decrement: 1 },
        },
      }),
    ).catch(() => {
      console.error("[deployments] undelivered step release failed");
    });
  }
  private async pruneHealthHistory() {
    // Only terminal periodic health metadata is disposable. Startup/stop intent and active health remain durable.
    const instances = await this.db.deploymentInstance.findMany({
      where: {
        ...(this.retentionCursor ? { id: { gt: this.retentionCursor } } : {}),
        Steps: { some: { phase: "health", state: { in: ["SUCCEEDED", "FAILED"] } } },
      },
      select: { id: true, userId: true },
      orderBy: { id: "asc" },
      take: BATCH,
    });
    this.retentionCursor = instances.at(-1)?.id ?? null;
    for (const instance of instances) {
      if (this.stopped) return;
      await this.locked(instance.userId, instance.id, async (tx) => {
        const obsolete = await tx.deploymentStep.findMany({
          where: {
            instanceId: instance.id,
            phase: "health",
            state: { in: ["SUCCEEDED", "FAILED"] },
            leaseExpiresAt: null,
          },
          orderBy: [{ sequence: "desc" }, { id: "desc" }],
          skip: 128,
          take: BATCH,
          select: { id: true },
        });
        if (obsolete.length)
          await tx.deploymentStep.deleteMany({
            where: {
              id: { in: obsolete.map((s) => s.id) },
              phase: "health",
              state: { in: ["SUCCEEDED", "FAILED"] },
              leaseExpiresAt: null,
            },
          });
      });
    }
  }
  private async maintenance() {
    const instances = await this.db.deploymentInstance.findMany({
      where: {
        ...(this.instanceCursor
          ? {
              AND: [
                {
                  OR: [
                    { updatedAt: { gt: this.instanceCursor.updatedAt } },
                    {
                      updatedAt: this.instanceCursor.updatedAt,
                      id: { gt: this.instanceCursor.id },
                    },
                  ],
                },
              ],
            }
          : {}),
        OR: [
          { desiredState: "STOPPED", observedState: { not: "STOPPED" } },
          {
            desiredState: "RUNNING",
            observedState: {
              in: ["PENDING", "STARTING", "RUNNING", "UNHEALTHY", "STOP_PENDING", "STOPPED"],
            },
          },
        ],
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: BATCH,
      select: { id: true, updatedAt: true, userId: true },
    });
    const lastInstance = instances.at(-1);
    this.instanceCursor = lastInstance
      ? { updatedAt: lastInstance.updatedAt, id: lastInstance.id }
      : null;
    for (const row of instances) {
      if (this.stopped) return;
      await this.locked(row.userId, row.id, async (tx) => {
        const instance = await tx.deploymentInstance.findUniqueOrThrow({
          where: { id: row.id },
          include: { Nodes: true, Revision: true },
        });
        if (["PENDING", "STARTING"].includes(instance.observedState)) {
          const liveNodes = await tx.cliDevice.findMany({
            where: {
              id: { in: instance.Nodes.map((n) => n.cliDeviceId) },
              status: "CONNECTED",
              lastHeartbeatAt: { gte: new Date(Date.now() - STOP_GRACE) },
            },
            select: { id: true },
          });
          if (
            liveNodes.length !== instance.Nodes.length &&
            Date.now() - instance.createdAt.getTime() >= STOP_GRACE
          ) {
            await this.gangStop(tx, instance.id, "node_offline");
            return;
          }
          const readiness = await tx.deploymentStep.findFirst({
            where: {
              instanceId: instance.id,
              phase: "readiness",
              state: "SUCCEEDED",
              sequence: {
                gte: instance.restartAttempts * 10,
                lt: (instance.restartAttempts + 1) * 10,
              },
            },
          });
          const unfinished = await tx.deploymentStep.count({
            where: {
              instanceId: instance.id,
              phase: { in: ["prepare", "start", "after_join", "readiness"] },
              sequence: {
                gte: instance.restartAttempts * 10,
                lt: (instance.restartAttempts + 1) * 10,
              },
              state: { not: "SUCCEEDED" },
            },
          });
          if (readiness && !unfinished && instance.desiredState === "RUNNING") {
            await tx.deploymentInstance.update({
              where: { id: instance.id },
              data: { observedState: "RUNNING", lastHealthAt: new Date() },
            });
            await tx.endpoint.updateMany({
              where: { deploymentInstanceId: instance.id },
              data: { published: true, status: "ONLINE", unpublishedAt: null },
            });
            await tx.discoveredModel.updateMany({
              where: { Endpoint: { deploymentInstanceId: instance.id } },
              data: { published: true, unpublishedAt: null },
            });
            await this.attachMembers(tx, instance.id);
            await tx.poolMember.updateMany({
              where: memberWhere(instance.id),
              data: { instanceGate: "OPEN", routingStatus: "ACTIVE" },
            });
          }
          return;
        }
        if (instance.desiredState === "STOPPED") {
          await tx.poolMember.updateMany({
            where: memberWhere(instance.id),
            data: { instanceGate: "CLOSED", routingStatus: "DRAINING" },
          });
          await tx.endpoint.updateMany({
            where: { deploymentInstanceId: instance.id },
            data: { published: false, unpublishedAt: new Date() },
          });
          // A start waiting for its person is cancelled by the desired stop (design §4); the
          // stop's status-first check settles a start that never ran without anyone.
          await this.settleOperatorStarts(tx, instance.id, "desired_stop");
          if (instance.Nodes.every((n) => !n.claimHeld)) {
            await tx.deploymentInstance.update({
              where: { id: instance.id },
              data: { observedState: "STOPPED" },
            });
            await this.syncNeedsOperator(tx, instance.id);
          }
          return;
        }
        if (
          instance.observedState === "STOP_PENDING" &&
          instance.Nodes.every((n) => !n.claimHeld)
        ) {
          // Every claim was released by a confirmed stop; settle so restart can proceed.
          await tx.deploymentInstance.update({
            where: { id: instance.id },
            data: { observedState: "STOPPED" },
          });
          await this.settleOperatorStarts(tx, instance.id, OPERATOR_SUPERSEDED);
          await this.syncNeedsOperator(tx, instance.id);
          return;
        }
        const liveNodes = await tx.cliDevice.findMany({
          where: {
            id: { in: instance.Nodes.map((n) => n.cliDeviceId) },
            status: "CONNECTED",
            lastHeartbeatAt: { gte: new Date(Date.now() - STOP_GRACE) },
          },
          select: { id: true },
        });
        const offline = liveNodes.length !== instance.Nodes.length;
        if (offline) {
          await tx.poolMember.updateMany({
            where: memberWhere(instance.id),
            data: { instanceGate: "CLOSED" },
          });
          if (Date.now() - instance.updatedAt.getTime() >= STOP_GRACE)
            await this.gangStop(tx, instance.id, "node_offline");
          return;
        }
        if (
          instance.observedState === "STOPPED" &&
          instance.nextRestartAt &&
          instance.nextRestartAt.getTime() <= Date.now()
        ) {
          // A person's restart (an interactive start never restarts on its own) is not held
          // to the automatic three attempts, only to the generation limit.
          const personRequested =
            instance.operatorRestartRequestedAt !== null &&
            instance.nextRestartAt.getTime() <= instance.operatorRestartRequestedAt.getTime();
          if (
            instance.restartAttempts >= (personRequested ? DEPLOYMENT_OPERATOR_RESTART_LIMIT : 3)
          ) {
            await tx.deploymentInstance.update({
              where: { id: instance.id },
              data: { observedState: "FAILED", nextRestartAt: null },
            });
            return;
          }
          // A stop still in flight (a status check of held-unknown resources, or a person's
          // stop) finishes before the instance starts again.
          if (
            await tx.deploymentStep.count({
              where: {
                instanceId: instance.id,
                phase: "stop",
                state: { in: [...LIVE_STEP_STATES] },
              },
            })
          )
            return;
          if (
            instance.Nodes.some((n) => n.claimHeld) ||
            !(await deploymentExecutionAllowed(tx, instance.userId, instance.id, instance.runId))
          )
            return;
          // Do not reacquire released resources behind a newer reservation.
          if (
            await tx.deploymentInstanceNode.count({
              where: {
                cliDeviceId: { in: instance.Nodes.map((n) => n.cliDeviceId) },
                claimHeld: true,
                instanceId: { not: instance.id },
              },
            })
          )
            return;
          // Retaking the claim also covers resources held unknown since a cancelled stop.
          await tx.deploymentInstanceNode.updateMany({
            where: { instanceId: instance.id },
            data: { claimHeld: true, stoppedAt: null, heldUnknownSince: null },
          });
          const starts = await tx.deploymentStep.findMany({
            where: {
              instanceId: instance.id,
              phase: { in: ["prepare", "start", "after_join", "readiness"] },
              sequence: { lt: 10 },
            },
            orderBy: { createdAt: "asc" },
          });
          for (const s of starts)
            await tx.deploymentStep.create({
              data: {
                runId: s.runId,
                instanceId: s.instanceId,
                cliDeviceId: s.cliDeviceId,
                rank: s.rank,
                phase: s.phase,
                sequence: s.sequence + (instance.restartAttempts + 1) * 10,
                intent: s.intent as Prisma.InputJsonValue,
                intentHash: s.intentHash,
              },
            });
          await tx.deploymentInstance.update({
            where: { id: instance.id },
            data: {
              observedState: "PENDING",
              restartAttempts: { increment: 1 },
              nextRestartAt: null,
            },
          });
          return;
        }
        if (!["RUNNING", "UNHEALTHY"].includes(instance.observedState)) {
          // e.g. "stopped, needs you" for an interactive start (RESTART), kept current.
          if (instance.observedState === "STOPPED") await this.syncNeedsOperator(tx, instance.id);
          return;
        }
        await this.attachMembers(tx, instance.id);
        await tx.poolMember.updateMany({
          where: memberWhere(instance.id),
          data: {
            routingStatus: "ACTIVE",
            instanceGate: instance.observedState === "RUNNING" ? "OPEN" : "CLOSED",
          },
        });
        const variant = storedDeploymentSpecSchema
          .parse(instance.Revision.spec)
          .variants.find((v) => v.key === instance.variantKey);
        if (
          !variant ||
          (instance.lastHealthAt &&
            Date.now() - instance.lastHealthAt.getTime() < variant.health.intervalMs)
        )
          return;
        if (
          await tx.deploymentStep.count({
            where: {
              instanceId: instance.id,
              phase: "health",
              state: { in: ["PENDING", "RUNNING"] },
            },
          })
        )
          return;
        const base = await tx.deploymentStep.findFirst({
          where: { instanceId: instance.id, rank: 0, phase: "start" },
          orderBy: { createdAt: "desc" },
        });
        if (!base) return;
        const intent = deploymentHealthIntent(base.intent);
        const latest = await tx.deploymentStep.aggregate({
          where: { instanceId: instance.id, phase: "health" },
          _max: { sequence: true },
        });
        const sequence = Math.max(999, latest._max.sequence ?? 999) + 1;
        await tx.deploymentStep.create({
          data: {
            runId: instance.runId,
            instanceId: instance.id,
            cliDeviceId: base.cliDeviceId,
            rank: 0,
            phase: "health",
            sequence,
            intent,
            intentHash: deploymentFingerprint(intent),
          },
        });
      }).catch(() => {
        console.error("[deployments] instance reconciliation failed");
      });
    }
  }
}
