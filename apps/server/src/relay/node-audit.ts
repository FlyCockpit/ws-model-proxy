/**
 * The one writer of the node audit log (`NodeAuditEvent`; replaces CliAgentActionEvent and
 * DeploymentOperatorEvent).
 *
 * Contract:
 * - `recordNodeAuditEvent` is synchronous, never throws and never awaits the database: an
 *   audit failure cannot block, delay or fail the operation it describes. Every terminal
 *   outcome of an audited action calls it exactly once (file-op settle, node command,
 *   terminal open/accept/close, definition push, trust lowering, ...).
 * - Events go into a bounded in-process queue (drop-oldest past {@link NODE_AUDIT_QUEUE_CAP},
 *   counted and warned) and are written in batches by one single-flight flusher. A failed
 *   batch is dropped and counted (class-only log): the log is best-effort by design.
 * - Metadata only: the event has no content, diff, command text or output field, and every
 *   string is bounded and stripped of NUL / ill-formed text here.
 * - The flush runs outside any request's abort fence (`runWithDbShutdownPermit`) so a client
 *   abort does not cancel the write of the event that describes it; the global shutdown fence
 *   is checked here and drops instead of writing.
 * - Shutdown: `stopNodeAuditWriter` (called by the relay-maintenance stop, before the relay
 *   sessions close and the database fence arms) flushes the queue; events recorded after it
 *   (session-close cancellations) are flushed on the next tick.
 */
import prisma, { type Prisma } from "@ws-model-proxy/db";
import { isDbShutdownFenceArmed, runWithDbShutdownPermit } from "@ws-model-proxy/db/shutdown-fence";

export const NODE_AUDIT_QUEUE_CAP = 1000;
export const NODE_AUDIT_BATCH = 200;
export const NODE_AUDIT_FLUSH_DELAY_MS = 250;
const WARN_INTERVAL_MS = 60_000;

const ID_MAX = 128;
const SUBJECT_MAX = 4096;
const ETAG_MAX = 128;
const REASON_MAX = 64;

type AuditRow = Prisma.NodeAuditEventCreateManyInput;
export type NodeAuditKind = AuditRow["kind"];
export type NodeAuditOutcome = AuditRow["outcome"];
export type NodeAuditActor = AuditRow["actor"];

export const NODE_AUDIT_KINDS = [
  "command",
  "file_read",
  "file_stat",
  "file_list",
  "file_search",
  "file_write",
  "file_edit",
  "file_rename",
  "file_mkdir",
  "file_delete",
  "command_queued_for_user",
  "browser_terminal",
  "operator_terminal",
  "runtime_define",
  "runtime_remove",
  "metric_commands_define",
  "node_update",
  "trust_lower",
  "marked_stopped",
  "claim_released",
  "claim_release_request",
] as const satisfies readonly NodeAuditKind[];

export const NODE_AUDIT_OUTCOMES = [
  "completed",
  "refused",
  "failed",
  "cancelled",
  "declined",
  "expired",
  "unknown",
  "opened",
  "accepted",
  "closed",
  "auto_settled",
] as const satisfies readonly NodeAuditOutcome[];

const ACTORS = ["USER", "AGENT", "SYSTEM"] as const satisfies readonly NodeAuditActor[];

export type NodeAuditEventInput = {
  userId: string;
  nodeId: string;
  actor: NodeAuditActor;
  agentTokenId?: string | null;
  /** An OAuth client's grant (at most one of agentTokenId / mcpGrantId; hardening CHECK). */
  mcpGrantId?: string | null;
  kind: NodeAuditKind;
  /** File path, `hmac-sha256:<hex> <program>` for commands, `runtime:<id>@<version>`, ... */
  subject: string;
  etagBefore?: string | null;
  etagAfter?: string | null;
  bytes?: number | null;
  instanceId?: string | null;
  stepId?: string | null;
  rank?: number | null;
  exitCode?: number | null;
  outcome: NodeAuditOutcome;
  reason?: string | null;
  startedAt: Date;
  finishedAt?: Date | null;
};

const kinds: ReadonlySet<string> = new Set(NODE_AUDIT_KINDS);
const outcomes: ReadonlySet<string> = new Set(NODE_AUDIT_OUTCOMES);
const actors: ReadonlySet<string> = new Set(ACTORS);

const queue: AuditRow[] = [];
let dropped = 0;
let lastWarnAt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let flushing: Promise<void> | null = null;
let draining = false;

/** Text that Postgres accepts and the log can hold: well-formed, no NUL, bounded. */
function text(value: string, max: number): string {
  const clean = value.toWellFormed().replaceAll("\0", "�");
  return clean.length > max ? clean.slice(0, max).toWellFormed() : clean;
}

function optionalText(value: string | null | undefined, max: number): string | null {
  return typeof value === "string" && value.length > 0 ? text(value, max) : null;
}

function validDate(value: Date | null | undefined): Date | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value : null;
}

function optionalInt(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function toRow(event: NodeAuditEventInput): AuditRow | null {
  if (typeof event.userId !== "string" || event.userId === "") return null;
  if (typeof event.nodeId !== "string" || event.nodeId === "") return null;
  if (!kinds.has(event.kind) || !outcomes.has(event.outcome) || !actors.has(event.actor)) {
    return null;
  }
  const startedAt = validDate(event.startedAt);
  if (startedAt === null) return null;
  const bytes =
    typeof event.bytes === "number" && Number.isSafeInteger(event.bytes) && event.bytes >= 0
      ? BigInt(event.bytes)
      : null;
  const reason =
    typeof event.reason === "string" && event.reason !== ""
      ? text(event.reason, REASON_MAX).replaceAll(/[^A-Za-z0-9_:.-]/g, "_")
      : null;
  return {
    userId: text(event.userId, ID_MAX),
    nodeId: text(event.nodeId, ID_MAX),
    actor: event.actor,
    agentTokenId: optionalText(event.agentTokenId, ID_MAX),
    mcpGrantId: optionalText(event.mcpGrantId, ID_MAX),
    kind: event.kind,
    // Never empty (a CHECK): one bad row would fail its whole batch.
    subject: text(typeof event.subject === "string" ? event.subject : "", SUBJECT_MAX) || "-",
    etagBefore: optionalText(event.etagBefore, ETAG_MAX),
    etagAfter: optionalText(event.etagAfter, ETAG_MAX),
    bytes,
    instanceId: optionalText(event.instanceId, ID_MAX),
    stepId: optionalText(event.stepId, ID_MAX),
    rank: optionalInt(event.rank),
    exitCode: optionalInt(event.exitCode),
    outcome: event.outcome,
    reason,
    startedAt,
    // The CHECK wants finishedAt >= startedAt: a clock stepped back during the action must not
    // make one row fail (and with it the whole batch).
    finishedAt: laterOf(startedAt, validDate(event.finishedAt) ?? startedAt),
  };
}

function laterOf(first: Date, second: Date): Date {
  return second.getTime() < first.getTime() ? first : second;
}

function noteDropped(count: number): void {
  dropped += count;
  const now = Date.now();
  if (now - lastWarnAt < WARN_INTERVAL_MS) return;
  lastWarnAt = now;
  console.warn(`[audit] node audit log dropped ${dropped} event(s) so far`);
}

function schedule(): void {
  if (timer !== null || flushing !== null) return;
  timer = setTimeout(
    () => {
      timer = null;
      void flushNodeAudit();
    },
    draining ? 0 : NODE_AUDIT_FLUSH_DELAY_MS,
  );
  timer.unref?.();
}

/** Events dropped since start (queue overflow, failed batches, fence). */
export function nodeAuditDroppedCount(): number {
  return dropped;
}

/** Records one audited action. Never throws, never awaits: see the module docblock. */
export function recordNodeAuditEvent(event: NodeAuditEventInput): void {
  try {
    const row = toRow(event);
    if (row === null) {
      noteDropped(1);
      return;
    }
    queue.push(row);
    if (queue.length > NODE_AUDIT_QUEUE_CAP) {
      const overflow = queue.length - NODE_AUDIT_QUEUE_CAP;
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
    const batch = queue.splice(0, NODE_AUDIT_BATCH);
    try {
      await runWithDbShutdownPermit(async () => {
        // Rows of a user that no longer exists are not written: a delayed event must not
        // recreate the history of a deleted user once the deleted-user purge has run.
        const owners = await prisma.user.findMany({
          where: { id: { in: [...new Set(batch.map((row) => row.userId))] } },
          select: { id: true },
        });
        const live = new Set(owners.map((owner) => owner.id));
        const rows = batch.filter((row) => live.has(row.userId));
        if (rows.length < batch.length) noteDropped(batch.length - rows.length);
        if (rows.length > 0) await prisma.nodeAuditEvent.createMany({ data: rows });
      });
    } catch (error) {
      noteDropped(batch.length);
      // Prisma errors can carry SQL and parameters; log the class only.
      console.error(
        "[audit] node audit write failed:",
        error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
      );
    }
  }
}

/** Writes everything queued now. Single-flight; resolves when the queue is empty. Never rejects. */
export function flushNodeAudit(): Promise<void> {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (flushing !== null) {
    return flushing.then(() => (queue.length > 0 ? flushNodeAudit() : undefined));
  }
  const run = writeBatches().finally(() => {
    flushing = null;
    if (queue.length > 0) schedule();
  });
  flushing = run;
  return run;
}

/** Shutdown step: flush now and flush later events without the batching delay. */
export async function stopNodeAuditWriter(): Promise<void> {
  draining = true;
  await flushNodeAudit();
}

/** Test seam: forget queued events and counters. */
export function resetNodeAuditForTests(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  queue.length = 0;
  dropped = 0;
  lastWarnAt = 0;
  draining = false;
}
