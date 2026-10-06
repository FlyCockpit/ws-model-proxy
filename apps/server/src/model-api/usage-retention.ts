/**
 * Hourly metrics retention:
 *
 *  1. Reap abandoned PENDING relay requests (no live local or provider attempt
 *     long after the relay deadline) through the same status-guarded terminal
 *     transition + rollup increment every other finalizer uses.
 *  2. Delete raw RelayRequest rows older than RELAY_REQUEST_RETENTION_DAYS.
 *     Attempt / AttemptEvent rows cascade in the database. Only TERMINAL rows are deleted:
 *     a terminal row has already been counted (every terminal transition
 *     records its rollup in the same transaction), while a PENDING row has
 *     not, so deleting it would lose its increment forever. PENDING rows
 *     past the cutoff stay until a finalizer, crash repair, or the reaper
 *     (step 1, drained in batches) counts them; the next sweep deletes them.
 *  3. Compact per-minute rollups older than 30 days into hourly rollups, then
 *     drop them (move = DELETE ... RETURNING + additive hourly upsert in ONE
 *     transaction, so a crash rolls both back and nothing is lost or doubled).
 *  4. Delete hourly rollups older than 13 months.
 *  5. Delete node audit events (node_audit_event, plain ids, no FKs: agent and person
 *     actions on nodes, operator terminals) older than NODE_AUDIT_RETENTION_DAYS, in
 *     `FOR UPDATE SKIP LOCKED` batches ordered by the (createdAt) index, and events whose
 *     user no longer exists (an independent bound behind the deletion drain and purge).
 *     Finished node commands (node_command) past their 30-day retention go too.
 *  6. Hot-path history sweeps (DL-1 design (d), #78; @ws-model-proxy/db/hot-path-sweeps):
 *     terminal admission history older than RELAY_REQUEST_RETENTION_DAYS (it
 *     no longer blocks a parent delete, so it needs its own bound), the rest
 *     of deleted users' history (the `deleted_user_purge` queue), and the
 *     scheduler state of deleted capacities, and expired Responses stickiness
 *     bindings (no foreign key removes them with their token or grant).
 *  6. Delete metric routing verdicts (`routing_verdict`) that
 *     expired more than ROUTING_VERDICT_RETENTION_MS ago. The table has no
 *     foreign keys (H-class), so rows of removed members, pools, devices or
 *     users are cleaned up here; an expired row is never used for routing.
 *
 *  7. Delete capacity_kv_eviction rows expired over an hour ago (class H,
 *     never drained; owner-scoped readers ignore expired rows).
 *  8. Delete runtime_load_minute rows older than
 *     ENGINE_LOAD_ROLLUP_MINUTE_RETENTION_DAYS (per-instance engine load).
 *  9. Delete node_metrics_minute rows older than
 *     NODE_METRICS_MINUTE_RETENTION_DAYS (CLI node-card sparklines).
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
  ENGINE_LOAD_ROLLUP_MINUTE_RETENTION_DAYS,
  NODE_METRICS_MINUTE_RETENTION_DAYS,
  USAGE_ROLLUP_HOUR_RETENTION_DAYS,
  USAGE_ROLLUP_MINUTE_RETENTION_DAYS,
} from "@ws-model-proxy/config/usage-metrics";
import defaultPrisma from "@ws-model-proxy/db";
import { deleteTerminalRelayRequestsWithoutWaiting } from "@ws-model-proxy/db/capacity-lock-order";
import {
  HOT_PATH_SWEEP_BATCH,
  NODE_COMMAND_RETENTION_MS,
  pruneExpiredStickiness,
  pruneOldNodeCommands,
  pruneOrphanCapacityScheduler,
  pruneTerminalCapacityHistory,
  purgeDeletedUsersHistory,
} from "@ws-model-proxy/db/hot-path-sweeps";
import { isDbShutdownFenceArmed } from "@ws-model-proxy/db/shutdown-fence";
import {
  USAGE_ROLLUP_COUNTERS,
  USAGE_ROLLUP_DIMENSIONS,
  USAGE_ROLLUP_HISTOGRAMS,
} from "@ws-model-proxy/db/usage-rollup-requester-drain";
import { MODEL_API_RELAY_TIMEOUT_MS } from "./limits.js";
import {
  BIG_ROLLUP_COUNTERS,
  recordRollupsForTransitionedRequests,
  truncateToHour,
  type UsageRollupIncrement,
  writeRollupIncrements,
} from "./usage-rollup.js";

export const USAGE_RETENTION_INTERVAL_MS = 60 * 60 * 1000;
/** Node audit events (agent and person actions on nodes, operator terminals) are kept this long. */
export const NODE_AUDIT_RETENTION_DAYS = 90;
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
  nodeAuditEventsDeleted: number;
  nodeCommandsDeleted: number;
  routingVerdictsDeleted: number;
  kvEvictionsDeleted: number;
  runtimeLoadMinutesDeleted: number;
  nodeMetricsMinutesDeleted: number;
  admissionHistoryPruned: number;
  deletedUserRowsPurged: number;
  orphanSchedulersDeleted: number;
  expiredStickinessDeleted: number;
};

/** Expired routing verdicts are kept this long (for the dashboard's "stale" badge). */
export const ROUTING_VERDICT_RETENTION_MS = 60 * 60 * 1000;

/** Disposable KV feedback has the same orphan/expiry retention as verdicts. */
export const KV_EVICTION_RETENTION_MS = 60 * 60 * 1000;

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
       WHERE r.status = 'PENDING'::"RequestStatus"
         AND r."startedAt" < ${cutoff}
         AND NOT EXISTS (
           SELECT 1 FROM attempt a
            WHERE a."requestId" = r.id AND a.state = 'ACTIVE'::"AttemptState")
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
    // Writer class S (@ws-model-proxy/db/capacity-lock-order): relay rows are taken with
    // SKIP LOCKED (admission_request.relayRequestId is a plain id, so no admission row is
    // rewritten); skipped rows are deleted by a later run.
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

type Dimension = (typeof USAGE_ROLLUP_DIMENSIONS)[number];
type MovedMinuteRow = {
  bucketStart: Date;
  ownerUserId: string;
  requesterUserId: string;
  source: UsageRollupIncrement["source"];
} & Record<Dimension, string> &
  Record<(typeof USAGE_ROLLUP_COUNTERS)[number], number | bigint> &
  Record<(typeof USAGE_ROLLUP_HISTOGRAMS)[number], number[] | null>;

const BIG_COUNTERS: ReadonlySet<string> = new Set(BIG_ROLLUP_COUNTERS);

/** Pure: re-keys moved minute rows onto their hour bucket. */
export function hourIncrementsFromMinuteRows(
  rows: readonly MovedMinuteRow[],
): UsageRollupIncrement[] {
  return rows.map((row) => {
    const increment: Record<string, unknown> = {
      bucketStart: truncateToHour(row.bucketStart),
      ownerUserId: row.ownerUserId,
      requesterUserId: row.requesterUserId,
      source: row.source,
    };
    for (const dimension of USAGE_ROLLUP_DIMENSIONS) increment[dimension] = row[dimension];
    for (const counter of USAGE_ROLLUP_COUNTERS)
      increment[counter] = BIG_COUNTERS.has(counter)
        ? BigInt(row[counter] ?? 0)
        : Number(row[counter] ?? 0);
    for (const histogram of USAGE_ROLLUP_HISTOGRAMS)
      increment[histogram] = (row[histogram] ?? []).map(Number);
    return increment as UsageRollupIncrement;
  });
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
        RETURNING m.*, m.source::text AS source`;
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

export async function deleteExpiredNodeAuditEvents({
  prisma = defaultPrisma as RetentionPrisma,
  now,
  retentionDays = NODE_AUDIT_RETENTION_DAYS,
  batch = USAGE_RETENTION_BATCH,
}: {
  prisma?: RetentionPrisma;
  now: Date;
  retentionDays?: number;
  batch?: number;
}): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  let deleted = 0;
  for (;;) {
    if (isDbShutdownFenceArmed()) return deleted;
    const count = await prisma.$executeRaw`
      DELETE FROM node_audit_event
       WHERE ctid IN (
         SELECT ctid FROM node_audit_event
          WHERE "createdAt" < ${cutoff}
          ORDER BY "createdAt"
          LIMIT ${batch}
          FOR UPDATE SKIP LOCKED)`;
    deleted += count;
    if (count < batch) return deleted;
  }
}

/**
 * Deletes node audit events whose user no longer exists: the table has no foreign key (plain
 * ids), so this recurring anti-join is the independent bound behind the user delete's drain
 * and the deleted-user purge. `user` is read only.
 */
export async function deleteOrphanNodeAuditEvents({
  prisma = defaultPrisma as RetentionPrisma,
  batch = USAGE_RETENTION_BATCH,
}: {
  prisma?: RetentionPrisma;
  batch?: number;
} = {}): Promise<number> {
  let deleted = 0;
  for (;;) {
    if (isDbShutdownFenceArmed()) return deleted;
    const count = await prisma.$executeRaw`
      DELETE FROM node_audit_event
       WHERE ctid IN (
         SELECT e.ctid FROM node_audit_event e
          WHERE NOT EXISTS (SELECT 1 FROM "user" u WHERE u.id = e."userId")
          LIMIT ${batch}
          FOR UPDATE OF e SKIP LOCKED)`;
    deleted += count;
    if (count < batch) return deleted;
  }
}

export async function deleteExpiredRoutingVerdicts({
  prisma = defaultPrisma as RetentionPrisma,
  now,
  batch = USAGE_RETENTION_BATCH,
}: {
  prisma?: RetentionPrisma;
  now: Date;
  batch?: number;
}): Promise<number> {
  const cutoff = new Date(now.getTime() - ROUTING_VERDICT_RETENTION_MS);
  let deleted = 0;
  for (;;) {
    if (isDbShutdownFenceArmed()) return deleted;
    const count = await prisma.$executeRaw`
      DELETE FROM routing_verdict
       WHERE ("poolMemberId", "executionTargetId") IN (
         SELECT "poolMemberId", "executionTargetId" FROM routing_verdict
          WHERE "expiresAt" < ${cutoff}
          LIMIT ${batch}
          FOR UPDATE SKIP LOCKED)`;
    deleted += count;
    if (count < batch) return deleted;
  }
}

export async function deleteExpiredKvEvictions({
  prisma = defaultPrisma as RetentionPrisma,
  now,
  batch = USAGE_RETENTION_BATCH,
}: {
  prisma?: RetentionPrisma;
  now: Date;
  batch?: number;
}): Promise<number> {
  const cutoff = new Date(now.getTime() - KV_EVICTION_RETENTION_MS);
  let deleted = 0;
  for (;;) {
    if (isDbShutdownFenceArmed()) return deleted;
    // The array is evaluated once: an IN semi-join can rescan its LIMIT and
    // lock/delete more than one batch under a nested-loop plan.
    const count = await prisma.$executeRaw`
      DELETE FROM capacity_kv_eviction
       WHERE "capacityId" = ANY(ARRAY(
         SELECT "capacityId" FROM capacity_kv_eviction
          WHERE "expiresAt" < ${cutoff}
          LIMIT ${batch}
          FOR UPDATE SKIP LOCKED))`;
    deleted += count;
    if (count < batch) return deleted;
  }
}

export async function deleteExpiredRuntimeLoadMinutes({
  prisma = defaultPrisma as RetentionPrisma,
  now,
  batch = USAGE_RETENTION_BATCH,
}: {
  prisma?: RetentionPrisma;
  now: Date;
  batch?: number;
}): Promise<number> {
  const cutoff = new Date(now.getTime() - ENGINE_LOAD_ROLLUP_MINUTE_RETENTION_DAYS * DAY_MS);
  let deleted = 0;
  for (;;) {
    if (isDbShutdownFenceArmed()) return deleted;
    const count = await prisma.$executeRaw`
      DELETE FROM runtime_load_minute
       WHERE ctid IN (
         SELECT ctid FROM runtime_load_minute
          WHERE "bucketStart" < ${cutoff}
          LIMIT ${batch}
          FOR UPDATE SKIP LOCKED)`;
    deleted += count;
    if (count < batch) return deleted;
  }
}

export async function deleteExpiredNodeMetricsMinutes({
  prisma = defaultPrisma as RetentionPrisma,
  now,
  batch = USAGE_RETENTION_BATCH,
}: {
  prisma?: RetentionPrisma;
  now: Date;
  batch?: number;
}): Promise<number> {
  const cutoff = new Date(now.getTime() - NODE_METRICS_MINUTE_RETENTION_DAYS * DAY_MS);
  let deleted = 0;
  for (;;) {
    if (isDbShutdownFenceArmed()) return deleted;
    const count = await prisma.$executeRaw`
      DELETE FROM node_metrics_minute
       WHERE ctid IN (
         SELECT ctid FROM node_metrics_minute
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
  sweepBatch = HOT_PATH_SWEEP_BATCH,
}: {
  prisma?: RetentionPrisma;
  retentionDays: number;
  /** Batch of the relay-request and rollup steps. */
  batch?: number;
  /** Batch of the hot-path history sweeps (their own bound). */
  sweepBatch?: number;
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
  const nodeAuditEventsDeleted =
    (await deleteExpiredNodeAuditEvents({ prisma, now, batch })) +
    (await deleteOrphanNodeAuditEvents({ prisma, batch }));
  const nodeCommandsDeleted = await pruneOldNodeCommands(prisma, {
    before: new Date(now.getTime() - NODE_COMMAND_RETENTION_MS),
    batch: sweepBatch,
  });
  const routingVerdictsDeleted = await deleteExpiredRoutingVerdicts({ prisma, now, batch });
  const kvEvictionsDeleted = await deleteExpiredKvEvictions({ prisma, now, batch });
  const runtimeLoadMinutesDeleted = await deleteExpiredRuntimeLoadMinutes({ prisma, now, batch });
  const nodeMetricsMinutesDeleted = await deleteExpiredNodeMetricsMinutes({ prisma, now, batch });
  const admissionHistoryPruned = await pruneTerminalCapacityHistory(prisma, {
    before: new Date(now.getTime() - retentionDays * DAY_MS),
    batch: sweepBatch,
  });
  const purged = await purgeDeletedUsersHistory(prisma, { now, batch: sweepBatch });
  const orphanSchedulersDeleted = await pruneOrphanCapacityScheduler(prisma, {
    batch: sweepBatch,
  });
  const expiredStickinessDeleted = await pruneExpiredStickiness(prisma, {
    now,
    batch: sweepBatch,
  });
  return {
    abandonedReaped,
    relayRequestsDeleted,
    minuteRowsCompacted,
    hourRowsDeleted,
    nodeAuditEventsDeleted,
    nodeCommandsDeleted,
    routingVerdictsDeleted,
    kvEvictionsDeleted,
    runtimeLoadMinutesDeleted,
    nodeMetricsMinutesDeleted,
    admissionHistoryPruned,
    deletedUserRowsPurged: purged.rows,
    orphanSchedulersDeleted,
    expiredStickinessDeleted,
  };
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
        result.hourRowsDeleted +
        result.nodeAuditEventsDeleted +
        result.nodeCommandsDeleted +
        result.admissionHistoryPruned +
        result.deletedUserRowsPurged +
        result.orphanSchedulersDeleted +
        result.expiredStickinessDeleted +
        result.routingVerdictsDeleted +
        result.kvEvictionsDeleted +
        result.runtimeLoadMinutesDeleted +
        result.nodeMetricsMinutesDeleted;
      if (total > 0)
        console.log(
          `[metrics] retention: reaped ${result.abandonedReaped}, deleted ${result.relayRequestsDeleted} relay request(s), compacted ${result.minuteRowsCompacted} minute rollup(s), deleted ${result.hourRowsDeleted} hourly rollup(s), deleted ${result.nodeAuditEventsDeleted} node audit event(s), deleted ${result.nodeCommandsDeleted} node command(s), pruned ${result.admissionHistoryPruned} admission request(s), purged ${result.deletedUserRowsPurged} deleted-user row(s), deleted ${result.orphanSchedulersDeleted} orphan scheduler row(s), deleted ${result.expiredStickinessDeleted} expired stickiness binding(s), deleted ${result.routingVerdictsDeleted} expired routing verdict(s), deleted ${result.kvEvictionsDeleted} expired KV feedback row(s), deleted ${result.runtimeLoadMinutesDeleted} runtime-load minute row(s), deleted ${result.nodeMetricsMinutesDeleted} node-metrics minute row(s).`,
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
