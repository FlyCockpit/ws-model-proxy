import { randomUUID } from "node:crypto";
import { deploymentFingerprint } from "@ws-model-proxy/api/lib/deployment-planner";
import {
  deploymentCommandActor,
  deploymentExecutionAllowed,
  lockDeploymentNodes,
  lockDeploymentOwner,
  mintDeploymentOperator,
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
import { z } from "zod";
import { MANAGED_IDENTITY_REFUSED } from "./managed-identity.js";

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
   * The session can hold operator terminals for interactive jobs (2.11 +
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
/** Whether a stored intent runs its command in an operator terminal, or its stop does. */
function operatorFlags(intent: Prisma.JsonValue) {
  const value =
    intent !== null && typeof intent === "object" && !Array.isArray(intent) ? intent : {};
  return {
    interactive: value.interactive === true,
    stopInteractive: value.stopInteractive === true,
  };
}
type StepRow = Prisma.DeploymentStepGetPayload<true>;
type InstanceRow = Pick<
  Prisma.DeploymentInstanceGetPayload<true>,
  "id" | "restartAttempts" | "desiredState" | "observedState"
>;
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
        if (succeeded) {
          await tx.deploymentInstanceNode.updateMany({
            where: {
              instanceId: step.instanceId,
              cliDeviceId: socket.cliDeviceId,
              rank: step.rank,
              claimHeld: true,
            },
            data: { claimHeld: false, stoppedAt: new Date() },
          });
          const held = await tx.deploymentInstanceNode.count({
            where: { instanceId: step.instanceId, claimHeld: true },
          });
          if (!held) {
            await tx.deploymentInstance.update({
              where: { id: step.instanceId },
              data: { observedState: "STOPPED" },
            });
            await tx.poolMember.updateMany({
              where: memberWhere(step.instanceId),
              data: { instanceGate: "CLOSED", routingStatus: "DISABLED" },
            });
          }
        } else {
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
   * 2.11 operator progress for an interactive step of the current dispatch (the session
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
   * `needsOperator=STEP` exactly while a step of the instance waits for a person (or a
   * person's run is past its timeout). A RESTART need (chunk 8) is left alone.
   */
  private async syncNeedsOperator(tx: Tx, instanceId: string) {
    const instance = await tx.deploymentInstance.findUnique({
      where: { id: instanceId },
      select: { needsOperator: true },
    });
    if (!instance || instance.needsOperator === "RESTART") return;
    // A person's run past its timeout needs them again too (it may hang on a prompt).
    const waiting = await tx.deploymentStep.count({
      where: {
        instanceId,
        OR: [
          { state: "AWAITING_OPERATOR" },
          { state: "RUNNING", operatorSince: { not: null }, deadline: { lte: new Date() } },
        ],
      },
    });
    if (waiting && instance.needsOperator === null)
      await tx.deploymentInstance.update({
        where: { id: instanceId },
        data: { needsOperator: "STEP", needsOperatorSince: new Date() },
      });
    else if (!waiting && instance.needsOperator === "STEP")
      await tx.deploymentInstance.update({
        where: { id: instanceId },
        data: { needsOperator: null, needsOperatorSince: null },
      });
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
    if (step.errorCode === reason) return;
    if (step.errorCode !== null && !OPERATOR_HOLD_CODES.includes(step.errorCode)) return;
    await tx.deploymentStep.updateMany({
      where: { id: step.id, state: "PENDING" },
      data: { errorCode: reason },
    });
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
              // A verified reconnect observation can settle only the exact durable stop.
              if (
                step.phase !== "stop" ||
                !["STOPPING", "STOP_PENDING"].includes(node.Instance.observedState) ||
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
              if (
                !(await tx.deploymentInstanceNode.count({
                  where: { instanceId: node.instanceId, claimHeld: true },
                }))
              )
                await tx.deploymentInstance.update({
                  where: { id: node.instanceId },
                  data: { observedState: "STOPPED" },
                });
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
  private async gangStop(tx: Tx, instanceId: string, code: string) {
    const instance = await tx.deploymentInstance.findUniqueOrThrow({
      where: { id: instanceId },
      include: { Nodes: { where: { claimHeld: true } } },
    });
    await tx.deploymentInstance.update({
      where: { id: instanceId },
      data: {
        // Without held claims nothing can still be running, so there is nothing to stop.
        observedState: instance.Nodes.length ? "STOP_PENDING" : "STOPPED",
        ...(instance.desiredState === "RUNNING"
          ? { nextRestartAt: new Date(Date.now() + (BACKOFF[instance.restartAttempts] ?? 300_000)) }
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
      const activeStop = await tx.deploymentStep.findFirst({
        where: { ...currentStops, state: { in: ["PENDING", "RUNNING"] } },
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
        Instance: { select: { userId: true } },
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: BATCH,
    });
    const lastStep = rows.at(-1);
    this.stepCursor = lastStep ? { updatedAt: lastStep.updatedAt, id: lastStep.id } : null;
    for (const row of rows) {
      if (this.stopped) return;
      const dispatch = await this.locked(row.Instance.userId, row.instanceId, async (tx) => {
        const step = await tx.deploymentStep.findUnique({
          where: { id: row.id },
          include: { Instance: { include: { Nodes: true } } },
        });
        if (!step || !["PENDING", "RUNNING", "AWAITING_OPERATOR"].includes(step.state)) return null;
        const instance = step.Instance;
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
    await this.pruneHealthHistory();
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
          if (instance.Nodes.every((n) => !n.claimHeld))
            await tx.deploymentInstance.update({
              where: { id: instance.id },
              data: { observedState: "STOPPED" },
            });
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
          if (instance.restartAttempts >= 3) {
            await tx.deploymentInstance.update({
              where: { id: instance.id },
              data: { observedState: "FAILED", nextRestartAt: null },
            });
            return;
          }
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
          await tx.deploymentInstanceNode.updateMany({
            where: { instanceId: instance.id },
            data: { claimHeld: true, stoppedAt: null },
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
        if (!["RUNNING", "UNHEALTHY"].includes(instance.observedState)) return;
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
