/**
 * The one writer of the operator-terminal audit log (`DeploymentOperatorEvent`,
 * interactive deployment steps, design §2/§6).
 *
 * Same contract as the agent audit (`../relay/cli-agent-audit.ts`):
 * - `recordDeploymentOperatorEvent` is synchronous, never throws and never
 *   awaits the database: an audit failure cannot block or fail the terminal
 *   or deployment frame it describes.
 * - Events go into a bounded in-process queue (drop-oldest past
 *   {@link DEPLOYMENT_OPERATOR_AUDIT_QUEUE_CAP}) and are written in batches by
 *   one single-flight flusher; a failed batch is dropped and counted.
 * - Metadata only: no command text (the step intent holds it) and no output.
 *   Rows of a user that no longer exists are not written.
 * - Shutdown: `stopDeploymentOperatorAuditWriter` flushes the queue (relay
 *   maintenance stop); `flushDeploymentOperatorAudit` runs again after the
 *   relay sessions closed, for the `closed` rows their teardown records.
 */
import prisma from "@ws-model-proxy/db";
import { isDbShutdownFenceArmed, runWithDbShutdownPermit } from "@ws-model-proxy/db/shutdown-fence";

export const DEPLOYMENT_OPERATOR_AUDIT_QUEUE_CAP = 1000;
export const DEPLOYMENT_OPERATOR_AUDIT_BATCH = 200;
export const DEPLOYMENT_OPERATOR_AUDIT_FLUSH_DELAY_MS = 250;
const WARN_INTERVAL_MS = 60_000;
const ID_MAX = 128;

export const DEPLOYMENT_OPERATOR_ACTIONS = ["prepare", "start", "after_join", "stop"] as const;
export type DeploymentOperatorAction = (typeof DEPLOYMENT_OPERATOR_ACTIONS)[number];
export type DeploymentOperatorOutcome =
  | "opened"
  | "accepted"
  | "succeeded"
  | "failed"
  | "declined"
  | "closed"
  | "auto_settled"
  | "cancelled";
const OUTCOMES: ReadonlySet<string> = new Set<DeploymentOperatorOutcome>([
  "opened",
  "accepted",
  "succeeded",
  "failed",
  "declined",
  "closed",
  "auto_settled",
  "cancelled",
]);
/** The schema CHECK: an exit code only on these outcomes. */
const EXIT_CODE_OUTCOMES: ReadonlySet<string> = new Set(["succeeded", "failed", "closed"]);

export function isDeploymentOperatorAction(value: string): value is DeploymentOperatorAction {
  return (DEPLOYMENT_OPERATOR_ACTIONS as readonly string[]).includes(value);
}

export type DeploymentOperatorEventInput = {
  userId: string;
  instanceId: string;
  stepId: string;
  cliDeviceId: string;
  rank: number;
  action: string;
  outcome: DeploymentOperatorOutcome;
  exitCode?: number | null;
};

type AuditRow = {
  userId: string;
  instanceId: string;
  stepId: string;
  cliDeviceId: string;
  rank: number;
  action: DeploymentOperatorAction;
  outcome: DeploymentOperatorOutcome;
  exitCode: number | null;
};

const queue: AuditRow[] = [];
let dropped = 0;
let lastWarnAt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let flushing: Promise<void> | null = null;
let draining = false;

function id(value: unknown): string | null {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= ID_MAX &&
    !value.includes("\0") &&
    value.isWellFormed()
    ? value
    : null;
}

function toRow(event: DeploymentOperatorEventInput): AuditRow | null {
  const userId = id(event.userId);
  const instanceId = id(event.instanceId);
  const stepId = id(event.stepId);
  const cliDeviceId = id(event.cliDeviceId);
  if (userId === null || instanceId === null || stepId === null || cliDeviceId === null)
    return null;
  if (!Number.isInteger(event.rank) || event.rank < 0 || event.rank > 63) return null;
  if (!isDeploymentOperatorAction(event.action) || !OUTCOMES.has(event.outcome)) return null;
  const exitCode =
    typeof event.exitCode === "number" &&
    Number.isInteger(event.exitCode) &&
    event.exitCode >= 0 &&
    event.exitCode <= 255 &&
    EXIT_CODE_OUTCOMES.has(event.outcome)
      ? event.exitCode
      : null;
  return {
    userId,
    instanceId,
    stepId,
    cliDeviceId,
    rank: event.rank,
    action: event.action,
    outcome: event.outcome,
    exitCode,
  };
}

function noteDropped(count: number): void {
  dropped += count;
  const now = Date.now();
  if (now - lastWarnAt < WARN_INTERVAL_MS) return;
  lastWarnAt = now;
  console.warn(`[audit] deployment operator audit dropped ${dropped} event(s) so far`);
}

function schedule(): void {
  if (timer !== null || flushing !== null) return;
  timer = setTimeout(
    () => {
      timer = null;
      void flushDeploymentOperatorAudit();
    },
    draining ? 0 : DEPLOYMENT_OPERATOR_AUDIT_FLUSH_DELAY_MS,
  );
  timer.unref?.();
}

/** Events dropped since start (invalid, queue overflow, failed batches, fence). */
export function deploymentOperatorAuditDroppedCount(): number {
  return dropped;
}

/** Records one operator-terminal event. Never throws, never awaits. */
export function recordDeploymentOperatorEvent(event: DeploymentOperatorEventInput): void {
  try {
    const row = toRow(event);
    if (row === null) {
      noteDropped(1);
      return;
    }
    queue.push(row);
    if (queue.length > DEPLOYMENT_OPERATOR_AUDIT_QUEUE_CAP) {
      const overflow = queue.length - DEPLOYMENT_OPERATOR_AUDIT_QUEUE_CAP;
      queue.splice(0, overflow);
      noteDropped(overflow);
    }
    schedule();
  } catch {
    noteDropped(1);
  }
}

async function writeBatches(): Promise<void> {
  while (queue.length > 0) {
    if (isDbShutdownFenceArmed()) {
      noteDropped(queue.length);
      queue.length = 0;
      return;
    }
    const batch = queue.splice(0, DEPLOYMENT_OPERATOR_AUDIT_BATCH);
    try {
      await runWithDbShutdownPermit(async () => {
        // A delayed event must not recreate history of a deleted user.
        const owners = await prisma.user.findMany({
          where: { id: { in: [...new Set(batch.map((row) => row.userId))] } },
          select: { id: true },
        });
        const live = new Set(owners.map((owner) => owner.id));
        const rows = batch.filter((row) => live.has(row.userId));
        if (rows.length < batch.length) noteDropped(batch.length - rows.length);
        if (rows.length > 0) await prisma.deploymentOperatorEvent.createMany({ data: rows });
      });
    } catch (error) {
      noteDropped(batch.length);
      // Prisma errors can carry SQL and parameters; log the class only.
      console.error(
        "[audit] deployment operator audit write failed:",
        error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
      );
    }
  }
}

/** Writes everything queued now. Single-flight; never rejects. */
export function flushDeploymentOperatorAudit(): Promise<void> {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (flushing !== null) {
    return flushing.then(() => (queue.length > 0 ? flushDeploymentOperatorAudit() : undefined));
  }
  const run = writeBatches().finally(() => {
    flushing = null;
    if (queue.length > 0) schedule();
  });
  flushing = run;
  return run;
}

/** Shutdown step: flush now and later events without the batching delay. */
export async function stopDeploymentOperatorAuditWriter(): Promise<void> {
  draining = true;
  await flushDeploymentOperatorAudit();
}

/** Test seam: forget queued events and counters. */
export function resetDeploymentOperatorAuditForTests(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  queue.length = 0;
  dropped = 0;
  lastWarnAt = 0;
  draining = false;
}

/** Test seam: the queued rows, oldest first. */
export function queuedDeploymentOperatorEventsForTests(): readonly AuditRow[] {
  return [...queue];
}
