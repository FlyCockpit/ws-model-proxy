/**
 * Hourly metrics retention:
 *
 *  1. Reap abandoned PENDING relay requests (no live local or provider attempt
 *     long after the relay deadline) through the same status-guarded terminal
 *     transition + rollup increment every other finalizer uses.
 *  2. Delete raw RelayRequest rows older than RELAY_REQUEST_RETENTION_DAYS.
 *     RelayExecutionEvent / RelayExecutionAttempt rows cascade in the database;
 *     AdmissionRequest links are set null. Only TERMINAL rows are deleted:
 *     a terminal row has already been counted (every terminal transition
 *     records its rollup in the same transaction), while a PENDING row has
 *     not, so deleting it would lose its increment forever. PENDING rows
 *     past the cutoff stay until a finalizer, crash repair, or the reaper
 *     (step 1, drained in batches) counts them; the next sweep deletes them.
 *  3. Compact per-minute rollups older than 30 days into hourly rollups, then
 *     drop them (move = DELETE ... RETURNING + additive hourly upsert in ONE
 *     transaction, so a crash rolls both back and nothing is lost or doubled).
 *  4. Delete hourly rollups older than 13 months.
 *
 * Multi-replica safety: every batch selects its rows with
 * `FOR UPDATE SKIP LOCKED`, so concurrent sweepers work on disjoint rows; the
 * reaper re-asserts `status = PENDING` in its guarded update; deletes of rows
 * another replica already removed are count-zero no-ops; hourly upserts are
 * additive over disjoint minute rows and applied in sorted key order (one
 * lock order). Every step is idempotent: re-running it after a crash only
 * processes rows that are still eligible.
 *
 * Shutdown: the job owns no durable intent beyond the rows themselves. It
 * checks the DB shutdown fence between batches and leaves any residual for the
 * next run.
 */

import {
  USAGE_ROLLUP_HOUR_RETENTION_DAYS,
  USAGE_ROLLUP_MINUTE_RETENTION_DAYS,
} from "@ws-model-proxy/config/usage-metrics";
import defaultPrisma from "@ws-model-proxy/db";
import { deleteTerminalRelayRequestsWithoutWaiting } from "@ws-model-proxy/db/capacity-lock-order";
import { isDbShutdownFenceArmed } from "@ws-model-proxy/db/shutdown-fence";
import { MODEL_API_RELAY_TIMEOUT_MS } from "./limits.js";
import {
  recordRollupsForTransitionedRequests,
  truncateToHour,
  type UsageRollupIncrement,
  writeRollupIncrements,
} from "./usage-rollup.js";

export const USAGE_RETENTION_INTERVAL_MS = 60 * 60 * 1000;
export const USAGE_RETENTION_BATCH = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A PENDING request older than this with no live attempt can no longer be
 * finalized by its owner: the relay deadline is MODEL_API_RELAY_TIMEOUT_MS,
 * and live local/provider attempts are excluded explicitly.
 */
export const ABANDONED_PENDING_AFTER_MS = Math.max(
  2 * 60 * 60 * 1000,
  4 * MODEL_API_RELAY_TIMEOUT_MS,
);

type RetentionPrisma = Pick<typeof defaultPrisma, "$queryRaw" | "$executeRaw" | "$transaction">;

export type UsageRetentionResult = {
  abandonedReaped: number;
  relayRequestsDeleted: number;
  minuteRowsCompacted: number;
  hourRowsDeleted: number;
};

async function databaseNow(prisma: Pick<typeof defaultPrisma, "$queryRaw">): Promise<Date> {
  const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  if (!clock) throw new Error("Database clock query returned no row");
  return clock.now;
}

export async function reapAbandonedPendingRequests({
  prisma = defaultPrisma as RetentionPrisma,
  now,
  batch = USAGE_RETENTION_BATCH,
}: {
  prisma?: RetentionPrisma;
  now: Date;
  batch?: number;
}): Promise<number> {
  const cutoff = new Date(now.getTime() - ABANDONED_PENDING_AFTER_MS);
  let reaped = 0;
  // Drains the whole eligible backlog in batches (not one batch per sweep):
  // every candidate a batch returns leaves the candidate set, because either
  // this sweep's guarded update moves it out of PENDING or another finalizer
  // already did, so each round makes progress and the loop terminates.
  for (;;) {
    if (isDbShutdownFenceArmed()) return reaped;
    const candidates = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT r.id FROM relay_request r
       WHERE r.status = 'PENDING'::"RelayRequestStatus"
         AND r."startedAt" < ${cutoff}
         AND NOT EXISTS (
           SELECT 1 FROM relay_execution_attempt a
            WHERE a."relayRequestId" = r.id AND a.state = 'ACTIVE')
         AND NOT EXISTS (
           SELECT 1 FROM provider_attempt p
            WHERE p."requestId" = r.id AND p.state = 'ACTIVE'::"ProviderAttemptState")
       ORDER BY r."startedAt"
       LIMIT ${batch}`;
    for (const { id } of candidates) {
      if (isDbShutdownFenceArmed()) return reaped;
      reaped += await prisma.$transaction(async (tx) => {
        const clock = await databaseNow(tx);
        const transitioned = await tx.relayRequest.updateMany({
          where: { id, status: "PENDING", startedAt: { lt: cutoff } },
          data: { status: "FAILED", completedAt: clock, errorClass: "abandoned" },
        });
        if (transitioned.count !== 1) return 0;
        await recordRollupsForTransitionedRequests(tx, [id], clock);
        return 1;
      });
    }
    if (candidates.length < batch) return reaped;
  }
}

export async function deleteExpiredRelayRequests({
  prisma = defaultPrisma as RetentionPrisma,
  now,
  retentionDays,
  batch = USAGE_RETENTION_BATCH,
}: {
  prisma?: RetentionPrisma;
  now: Date;
  retentionDays: number;
  batch?: number;
}): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  let deleted = 0;
  for (;;) {
    if (isDbShutdownFenceArmed()) return deleted;
    // Terminal rows only (see step 2 above): a PENDING row has not been
    // counted yet. A row an in-flight finalizer is transitioning is locked and
    // skipped; FOR UPDATE re-evaluates the predicate on the latest row
    // version, and no writer ever moves a row back to PENDING (only
    // createRelayMetadata writes PENDING), so a selected row is terminal and
    // already counted.
    //
    // Capacity lock order (@ws-model-proxy/db/capacity-lock-order): the
    // DELETE's ON DELETE SET NULL rewrites admission_request rows, which an
    // admitter locks before it updates their relay rows. The shared helper
    // takes the admission rows and then the relay rows with SKIP LOCKED, so
    // this delete never waits on a row an admitter holds; skipped rows are
    // deleted by a later run.
    const count = await prisma.$transaction(async (tx) => {
      const picked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM relay_request
         WHERE "createdAt" < ${cutoff}
           AND status IN ('SUCCEEDED', 'FAILED', 'CANCELED')
         ORDER BY "createdAt"
         LIMIT ${batch}`;
      return deleteTerminalRelayRequestsWithoutWaiting(
        tx,
        picked.map((row) => row.id),
      );
    });
    deleted += count;
    if (count < batch) return deleted;
  }
}

type MovedMinuteRow = {
  bucketStart: Date;
  ownerUserId: string;
  requesterUserId: string;
  poolId: string;
  poolMemberId: string;
  executionTargetId: string;
  source: UsageRollupIncrement["source"];
  requests: number;
  successes: number;
  errors: number;
  cancels: number;
  retries: number;
  usageKnownRequests: number;
  inputTokens: bigint;
  outputTokens: bigint;
  cacheReadTokens: bigint;
  cacheWriteTokens: bigint;
  cacheKnownRequests: number;
  cacheKnownInputTokens: bigint;
  durationCount: number;
  durationSumMs: bigint;
  latencyHistogram: number[] | null;
  ttftCount: number;
  ttftSumMs: bigint;
  ttftHistogram: number[] | null;
};

/** Pure: re-keys moved minute rows onto their hour bucket. */
export function hourIncrementsFromMinuteRows(
  rows: readonly MovedMinuteRow[],
): UsageRollupIncrement[] {
  return rows.map((row) => ({
    bucketStart: truncateToHour(row.bucketStart),
    ownerUserId: row.ownerUserId,
    requesterUserId: row.requesterUserId,
    poolId: row.poolId,
    poolMemberId: row.poolMemberId,
    executionTargetId: row.executionTargetId,
    source: row.source,
    requests: Number(row.requests),
    successes: Number(row.successes),
    errors: Number(row.errors),
    cancels: Number(row.cancels),
    retries: Number(row.retries),
    usageKnownRequests: Number(row.usageKnownRequests),
    inputTokens: BigInt(row.inputTokens),
    outputTokens: BigInt(row.outputTokens),
    cacheReadTokens: BigInt(row.cacheReadTokens),
    cacheWriteTokens: BigInt(row.cacheWriteTokens),
    cacheKnownRequests: Number(row.cacheKnownRequests),
    cacheKnownInputTokens: BigInt(row.cacheKnownInputTokens),
    durationCount: Number(row.durationCount),
    durationSumMs: BigInt(row.durationSumMs),
    latencyHistogram: (row.latencyHistogram ?? []).map(Number),
    ttftCount: Number(row.ttftCount),
    ttftSumMs: BigInt(row.ttftSumMs),
    ttftHistogram: (row.ttftHistogram ?? []).map(Number),
  }));
}

export async function compactMinuteRollups({
  prisma = defaultPrisma as RetentionPrisma,
  now,
  batch = USAGE_RETENTION_BATCH,
}: {
  prisma?: RetentionPrisma;
  now: Date;
  batch?: number;
}): Promise<number> {
  const cutoff = new Date(now.getTime() - USAGE_ROLLUP_MINUTE_RETENTION_DAYS * DAY_MS);
  let moved = 0;
  for (;;) {
    if (isDbShutdownFenceArmed()) return moved;
    const count = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<MovedMinuteRow[]>`
        WITH picked AS (
          SELECT ctid FROM usage_rollup_minute
           WHERE "bucketStart" < ${cutoff}
           ORDER BY "bucketStart"
           LIMIT ${batch}
           FOR UPDATE SKIP LOCKED
        )
        DELETE FROM usage_rollup_minute m USING picked
         WHERE m.ctid = picked.ctid
        RETURNING m."bucketStart", m."ownerUserId", m."requesterUserId", m."poolId", m."poolMemberId",
          m."executionTargetId", m.source::text AS source, m.requests, m.successes,
          m.errors, m.cancels, m.retries, m."usageKnownRequests", m."inputTokens",
          m."outputTokens", m."cacheReadTokens", m."cacheWriteTokens",
          m."cacheKnownRequests", m."cacheKnownInputTokens", m."durationCount",
          m."durationSumMs", m."latencyHistogram", m."ttftCount", m."ttftSumMs",
          m."ttftHistogram"`;
      if (rows.length === 0) return 0;
      await writeRollupIncrements(tx, "usage_rollup_hour", hourIncrementsFromMinuteRows(rows));
      return rows.length;
    });
    moved += count;
    if (count < batch) return moved;
  }
}

export async function deleteExpiredHourRollups({
  prisma = defaultPrisma as RetentionPrisma,
  now,
  batch = USAGE_RETENTION_BATCH,
}: {
  prisma?: RetentionPrisma;
  now: Date;
  batch?: number;
}): Promise<number> {
  const cutoff = new Date(now.getTime() - USAGE_ROLLUP_HOUR_RETENTION_DAYS * DAY_MS);
  let deleted = 0;
  for (;;) {
    if (isDbShutdownFenceArmed()) return deleted;
    const count = await prisma.$executeRaw`
      DELETE FROM usage_rollup_hour
       WHERE ctid IN (
         SELECT ctid FROM usage_rollup_hour
          WHERE "bucketStart" < ${cutoff}
          LIMIT ${batch}
          FOR UPDATE SKIP LOCKED)`;
    deleted += count;
    if (count < batch) return deleted;
  }
}

export async function runUsageRetention({
  prisma = defaultPrisma as RetentionPrisma,
  retentionDays,
  batch = USAGE_RETENTION_BATCH,
}: {
  prisma?: RetentionPrisma;
  retentionDays: number;
  batch?: number;
}): Promise<UsageRetentionResult> {
  const now = await databaseNow(prisma);
  // Reap (drained) before deleting so abandoned requests are counted in the
  // same sweep that would otherwise age them out. The delete itself never
  // touches PENDING rows, so a residual backlog (shutdown fence, a row with a
  // still-live attempt) waits for the next sweep instead of being lost.
  const abandonedReaped = await reapAbandonedPendingRequests({ prisma, now, batch });
  const relayRequestsDeleted = await deleteExpiredRelayRequests({
    prisma,
    now,
    retentionDays,
    batch,
  });
  const minuteRowsCompacted = await compactMinuteRollups({ prisma, now, batch });
  const hourRowsDeleted = await deleteExpiredHourRollups({ prisma, now, batch });
  return { abandonedReaped, relayRequestsDeleted, minuteRowsCompacted, hourRowsDeleted };
}

let activeUsageRetentionStop: (() => void) | null = null;

export function startUsageRetention({
  retentionDays,
  intervalMs = USAGE_RETENTION_INTERVAL_MS,
  run = runUsageRetention,
}: {
  retentionDays: number;
  intervalMs?: number;
  run?: typeof runUsageRetention;
}): () => void {
  if (activeUsageRetentionStop !== null) return activeUsageRetentionStop;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await run({ retentionDays });
      const total =
        result.abandonedReaped +
        result.relayRequestsDeleted +
        result.minuteRowsCompacted +
        result.hourRowsDeleted;
      if (total > 0)
        console.log(
          `[metrics] retention: reaped ${result.abandonedReaped}, deleted ${result.relayRequestsDeleted} relay request(s), compacted ${result.minuteRowsCompacted} minute rollup(s), deleted ${result.hourRowsDeleted} hourly rollup(s).`,
        );
    } catch (error) {
      // Prisma errors can carry SQL and parameters; log the class only.
      console.error(
        "[metrics] retention sweep failed:",
        error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
      );
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  const stop = () => {
    clearInterval(timer);
    if (activeUsageRetentionStop === stop) activeUsageRetentionStop = null;
  };
  activeUsageRetentionStop = stop;
  return stop;
}
