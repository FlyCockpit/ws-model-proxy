/**
 * The one writer of the agent audit log (`CliAgentActionEvent`).
 *
 * Contract:
 * - `recordCliAgentAction` is synchronous, never throws and never awaits the
 *   database: an audit failure cannot block, delay or fail the operation it
 *   describes. Every terminal outcome of an agent action calls it exactly once
 *   (headless command, supervised command, and, with #103, the single file-op
 *   settle point: `recordCliAgentAction({ kind: "file_read", ... })`).
 * - Events go into a bounded in-process queue (drop-oldest past
 *   {@link CLI_AGENT_AUDIT_QUEUE_CAP}, counted and warned) and are written in
 *   batches by one single-flight flusher. A failed batch is dropped and
 *   counted (class-only log): the log is best-effort by design, and retrying
 *   forever would only grow a backlog while the database is unavailable.
 * - Metadata only: the event type has no content, diff, command text or
 *   output field, and every string is bounded and stripped of NUL /
 *   ill-formed text here.
 * - The flush runs outside any MCP request's abort fence
 *   (`runWithDbShutdownPermit`) so a client abort does not cancel the write of
 *   the event that describes it; the global shutdown fence is checked here
 *   and drops instead of writing.
 * - Shutdown: `stopCliAgentAuditWriter` (called by the relay-maintenance stop,
 *   which runs before the relay sessions close and the database fence arms)
 *   flushes the queue; events recorded after it (session-close cancellations)
 *   are flushed on the next tick.
 */
import {
  CLI_AGENT_ACTION_KINDS,
  CLI_AGENT_ACTION_OUTCOMES,
  type CliAgentActionEventInput,
} from "@ws-model-proxy/config/cli-agent-audit";
import prisma from "@ws-model-proxy/db";
import { isDbShutdownFenceArmed, runWithDbShutdownPermit } from "@ws-model-proxy/db/shutdown-fence";

export const CLI_AGENT_AUDIT_QUEUE_CAP = 1000;
export const CLI_AGENT_AUDIT_BATCH = 200;
export const CLI_AGENT_AUDIT_FLUSH_DELAY_MS = 250;
const WARN_INTERVAL_MS = 60_000;

const ID_MAX = 128;
const PATH_MAX = 4096;
const ETAG_MAX = 128;
const REASON_MAX = 64;

type AuditRow = {
  userId: string;
  cliDeviceId: string;
  mcpTokenId: string | null;
  kind: CliAgentActionEventInput["kind"];
  path: string;
  etagBefore: string | null;
  etagAfter: string | null;
  bytes: bigint | null;
  outcome: CliAgentActionEventInput["outcome"];
  reason: string | null;
  startedAt: Date;
  finishedAt: Date | null;
};

const kinds: ReadonlySet<string> = new Set(CLI_AGENT_ACTION_KINDS);
const outcomes: ReadonlySet<string> = new Set(CLI_AGENT_ACTION_OUTCOMES);

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

function toRow(event: CliAgentActionEventInput): AuditRow | null {
  if (typeof event.userId !== "string" || event.userId === "") return null;
  if (typeof event.cliDeviceId !== "string" || event.cliDeviceId === "") return null;
  if (!kinds.has(event.kind) || !outcomes.has(event.outcome)) return null;
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
    cliDeviceId: text(event.cliDeviceId, ID_MAX),
    mcpTokenId: optionalText(event.mcpTokenId, ID_MAX),
    kind: event.kind,
    path: text(typeof event.path === "string" ? event.path : "", PATH_MAX),
    etagBefore: optionalText(event.etagBefore, ETAG_MAX),
    etagAfter: optionalText(event.etagAfter, ETAG_MAX),
    bytes,
    outcome: event.outcome,
    reason,
    startedAt,
    finishedAt: validDate(event.finishedAt) ?? startedAt,
  };
}

function noteDropped(count: number): void {
  dropped += count;
  const now = Date.now();
  if (now - lastWarnAt < WARN_INTERVAL_MS) return;
  lastWarnAt = now;
  console.warn(`[audit] agent audit log dropped ${dropped} event(s) so far`);
}

function schedule(): void {
  if (timer !== null || flushing !== null) return;
  timer = setTimeout(
    () => {
      timer = null;
      void flushCliAgentAudit();
    },
    draining ? 0 : CLI_AGENT_AUDIT_FLUSH_DELAY_MS,
  );
  timer.unref?.();
}

/** Events dropped since start (queue overflow, failed batches, fence). */
export function cliAgentAuditDroppedCount(): number {
  return dropped;
}

/**
 * Records one agent action. Never throws, never awaits, never blocks the
 * caller: see the module docblock.
 */
export function recordCliAgentAction(event: CliAgentActionEventInput): void {
  try {
    const row = toRow(event);
    if (row === null) {
      noteDropped(1);
      return;
    }
    queue.push(row);
    if (queue.length > CLI_AGENT_AUDIT_QUEUE_CAP) {
      const overflow = queue.length - CLI_AGENT_AUDIT_QUEUE_CAP;
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
    const batch = queue.splice(0, CLI_AGENT_AUDIT_BATCH);
    try {
      await runWithDbShutdownPermit(() => prisma.cliAgentActionEvent.createMany({ data: batch }));
    } catch (error) {
      noteDropped(batch.length);
      // Prisma errors can carry SQL and parameters; log the class only.
      console.error(
        "[audit] agent audit write failed:",
        error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
      );
    }
  }
}

/** Writes everything queued now. Single-flight; resolves when the queue is empty. Never rejects. */
export function flushCliAgentAudit(): Promise<void> {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (flushing !== null) {
    // The running flush drains the queue in its loop; wait for it, then for any
    // events queued after its last check.
    return flushing.then(() => (queue.length > 0 ? flushCliAgentAudit() : undefined));
  }
  const run = writeBatches().finally(() => {
    flushing = null;
    if (queue.length > 0) schedule();
  });
  flushing = run;
  return run;
}

/**
 * Shutdown step: flush now and flush later events without the batching delay.
 * Called by the relay-maintenance stop.
 */
export async function stopCliAgentAuditWriter(): Promise<void> {
  draining = true;
  await flushCliAgentAudit();
}

/** Test seam: forget queued events and counters. */
export function resetCliAgentAuditForTests(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  queue.length = 0;
  dropped = 0;
  lastWarnAt = 0;
  draining = false;
}
