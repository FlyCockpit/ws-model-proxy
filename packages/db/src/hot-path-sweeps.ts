/**
 * Sweepers over the hot-path (writer class H) tables, DL-1 design (d) (#78).
 *
 * H tables reference graph rows (users, pools, targets, capacities) by plain
 * id, with no foreign key (./capacity-lock-order.ts). A graph delete therefore
 * leaves their rows behind; these sweepers (writer class S) clean them up.
 * Every statement takes its rows with SKIP LOCKED and none takes a fence, so
 * a sweep does not wait on a lock: a busy row is left for the next run. The
 * one bounded exception is the purge's requester-rollup merge, which can wait
 * up to PURGE_MERGE_LOCK_TIMEOUT_MS on a destination row a hot writer holds
 * (INSERT ... ON CONFLICT has no SKIP LOCKED); the batch then rolls back.
 *
 * - {@link purgeDeletedUsersHistory}: the rest of a deleted user's own
 *   history (the user-deletion drain removes the bulk before the user row is
 *   deleted; requests still in flight then finish afterwards), driven by the
 *   `deleted_user_purge` queue the user delete writes.
 * - {@link pruneTerminalCapacityHistory}: retention of terminal admission
 *   history (requests with their waiters and lease), which no longer blocks a
 *   parent delete and so needs its own bound.
 * - {@link pruneOrphanCapacityRuntime}: scheduler state of deleted capacities.
 *
 * Live admission rows of a deleted parent are terminalized by the admission
 * store's orphan sweep (apps/server/src/model-api/capacity/postgres-store.ts,
 * `sweepOrphans`), which needs the store's own fences.
 *
 * {@link clearCacheAffinityRecords} is the dashboard's "clear affinity"
 * action: an H write (it takes the pool's cache-affinity fence, like the
 * affinity writer) kept here so that only H and S modules write H tables.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../prisma/generated/client";
import { Prisma } from "../prisma/generated/client";
import {
  acquireFences,
  deleteTerminalRelayRequestsWithoutWaiting,
  fences,
  serverTimeoutSqlState,
} from "./capacity-lock-order";
import { USER_PLAIN_ID_HISTORY_TABLES } from "./parent-deletion-residual";
import { isDbShutdownFenceArmed } from "./shutdown-fence";
import { drainRequesterUsageRollupsBatch } from "./usage-rollup-requester-drain";

type SweepDb = Pick<PrismaClient, "$transaction" | "$queryRaw" | "$executeRaw">;

/** Rows per sweep statement. */
export const HOT_PATH_SWEEP_BATCH = 1_000;

/**
 * A deleted user's queue entry is removed only after this long, and only
 * once nothing of theirs is left: a request still in flight at the delete
 * can write its final history (relay status, rollups) until its relay
 * deadline has long passed.
 */
export const DELETED_USER_PURGE_GRACE_MS = 24 * 60 * 60 * 1000;

const TERMINAL_ADMISSION = Prisma.sql`('CANCELLED', 'EXPIRED', 'TERMINAL')`;

/**
 * Deletes up to `batch` terminal admission requests matching `where` (an SQL
 * condition on alias `r`), each together with every waiter (H-internal
 * cascade; its lease cascades too). A request whose waiter another
 * transaction holds is skipped, so the DELETE never waits on a waiter.
 * Returns how many candidate rows were examined (0 = nothing left).
 */
async function deleteTerminalAdmissionBatch(
  db: SweepDb,
  where: Prisma.Sql,
  batch: number,
): Promise<number> {
  return db.$transaction(async (tx) => {
    const candidates = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT r.id FROM admission_request r
       WHERE r.state IN ${TERMINAL_ADMISSION} AND ${where}
       ORDER BY r.id
       LIMIT ${batch}
         FOR UPDATE OF r SKIP LOCKED`;
    if (candidates.length === 0) return 0;
    const ids = candidates.map((row) => row.id);
    const held = await tx.$queryRaw<Array<{ admissionRequestId: string }>>`
      SELECT "admissionRequestId" FROM capacity_waiter
       WHERE "admissionRequestId" = ANY(${ids}::text[])
       ORDER BY id
         FOR UPDATE SKIP LOCKED`;
    const totals = await tx.$queryRaw<Array<{ admissionRequestId: string; total: bigint }>>`
      SELECT "admissionRequestId", count(*) AS total FROM capacity_waiter
       WHERE "admissionRequestId" = ANY(${ids}::text[])
       GROUP BY "admissionRequestId"`;
    const heldByRequest = new Map<string, number>();
    for (const row of held)
      heldByRequest.set(
        row.admissionRequestId,
        (heldByRequest.get(row.admissionRequestId) ?? 0) + 1,
      );
    const busy = new Set(
      totals
        .filter((row) => (heldByRequest.get(row.admissionRequestId) ?? 0) < Number(row.total))
        .map((row) => row.admissionRequestId),
    );
    const eligible = ids.filter((id) => !busy.has(id));
    if (eligible.length > 0)
      await tx.$executeRaw`
        DELETE FROM admission_request WHERE id = ANY(${eligible}::text[])`; // policy: bounded-delete -- ids locked and checked above
    return eligible.length === 0 ? 0 : candidates.length;
  });
}

async function sweepLoop(step: () => Promise<number>, batch: number): Promise<number> {
  let total = 0;
  for (;;) {
    if (isDbShutdownFenceArmed()) return total;
    const processed = await step();
    total += processed;
    if (processed < batch) return total;
  }
}

/**
 * Retention of terminal admission history: deletes terminal admission
 * requests last changed before `before`, with their waiters and lease, in
 * SKIP LOCKED batches. Returns the number of requests examined.
 */
export async function pruneTerminalCapacityHistory(
  db: SweepDb,
  { before, batch = HOT_PATH_SWEEP_BATCH }: { before: Date; batch?: number },
): Promise<number> {
  return sweepLoop(
    () => deleteTerminalAdmissionBatch(db, Prisma.sql`r."updatedAt" < ${before}`, batch),
    batch,
  );
}

/**
 * Deletes expired Responses stickiness bindings in SKIP LOCKED batches. A
 * binding has no foreign key to its token, grant or targets (DL-1 hot-path
 * history), so deleting those leaves it behind; it can never be served again
 * (routes.ts needs the exact live token and grant), and this sweep removes it
 * once its TTL passes. Returns the number of rows deleted.
 */
export async function pruneExpiredStickiness(
  db: SweepDb,
  { now, batch = HOT_PATH_SWEEP_BATCH }: { now: Date; batch?: number },
): Promise<number> {
  return sweepLoop(
    () => db.$executeRaw`
      DELETE FROM response_stickiness_record
       WHERE id IN (
         SELECT id FROM response_stickiness_record
          WHERE "expiresAt" < ${now}
          LIMIT ${batch}
            FOR UPDATE SKIP LOCKED)`,
    batch,
  );
}

/** Deletes `capacity_runtime` rows whose capacity no longer exists. */
export async function pruneOrphanCapacityRuntime(
  db: SweepDb,
  { batch = HOT_PATH_SWEEP_BATCH }: { batch?: number } = {},
): Promise<number> {
  return sweepLoop(
    () => db.$executeRaw`
      DELETE FROM capacity_runtime
       WHERE "capacityId" IN (
         SELECT runtime."capacityId" FROM capacity_runtime runtime
          WHERE NOT EXISTS (
            SELECT 1 FROM inference_capacity capacity WHERE capacity.id = runtime."capacityId")
          LIMIT ${batch}
            FOR UPDATE SKIP LOCKED)`,
    batch,
  );
}

/** Deletes one SKIP LOCKED batch of `table` rows whose `column` names `userId`. */
async function deleteOwnedBatch(
  db: SweepDb,
  table: string,
  key: string,
  column: string,
  userId: string,
  batch: number,
): Promise<number> {
  return db.$executeRaw`
    DELETE FROM ${Prisma.raw(`"${table}"`)}
     WHERE ${Prisma.raw(`"${key}"`)} IN (
       SELECT ${Prisma.raw(`"${key}"`)} FROM ${Prisma.raw(`"${table}"`)}
        WHERE ${Prisma.raw(`"${column}"`)} = ${userId}
        LIMIT ${batch}
          FOR UPDATE SKIP LOCKED)`;
}

/**
 * Purges one deleted user's remaining hot-path history. Returns the rows
 * processed and whether anything of the user's is left.
 */
export async function purgeDeletedUserHistory(
  db: SweepDb,
  userId: string,
  { batch = HOT_PATH_SWEEP_BATCH }: { batch?: number } = {},
): Promise<{ processed: number; remaining: boolean }> {
  let processed = 0;
  processed += await sweepLoop(
    () => deleteOwnedBatch(db, "response_stickiness_record", "id", "userId", userId, batch),
    batch,
  );
  for (const table of ["cache_affinity_record", "cache_affinity_node"])
    for (const column of ["userId", "tenantUserId"])
      processed += await sweepLoop(
        () => deleteOwnedBatch(db, table, "id", column, userId, batch),
        batch,
      );
  for (const table of ["cache_affinity_scope", "cache_affinity_observer"])
    processed += await sweepLoop(
      () =>
        db.$executeRaw(Prisma.sql`
        DELETE FROM ${Prisma.raw(table)} WHERE ctid = ANY(ARRAY(
          SELECT ctid FROM ${Prisma.raw(table)} WHERE "userId" = ${userId}
          LIMIT ${batch} FOR UPDATE SKIP LOCKED))`),
      batch,
    );
  processed += await sweepLoop(
    () =>
      deleteOwnedBatch(
        db,
        "cache_affinity_residency",
        "executionTargetId",
        "userId",
        userId,
        batch,
      ),
    batch,
  );
  processed += await sweepLoop(
    () => deleteOwnedBatch(db, "capacity_runtime", "capacityId", "userId", userId, batch),
    batch,
  );
  processed += await sweepLoop(
    () => deleteTerminalAdmissionBatch(db, Prisma.sql`r."userId" = ${userId}`, batch),
    batch,
  );
  processed += await sweepLoop(
    () =>
      db.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM relay_request
           WHERE "userId" = ${userId} AND status IN ('SUCCEEDED', 'FAILED', 'CANCELED')
           ORDER BY "createdAt", id
           LIMIT ${batch}`;
        const deleted = await deleteTerminalRelayRequestsWithoutWaiting(
          tx,
          rows.map((row) => row.id),
        );
        return deleted === 0 ? 0 : rows.length;
      }),
    batch,
  );
  for (const table of [
    "usage_rollup_minute",
    "usage_rollup_hour",
    "engine_load_rollup_minute",
    "node_metrics_minute",
  ])
    processed += await sweepLoop(
      () => deleteOwnedBatch(db, table, "ctid", "ownerUserId", userId, batch),
      batch,
    );
  processed += await sweepLoop(async () => {
    // The merge INSERT can wait on a destination row that a hot finalizer
    // or compactor holds; a purge (writer class S) does not queue behind
    // it. The short lock_timeout rolls the whole batch back (source rows
    // and destination adds stay atomic) and the entry is retried next run.
    try {
      return await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${PURGE_MERGE_LOCK_TIMEOUT_MS}ms`}, true)`;
        return drainRequesterUsageRollupsBatch(tx, userId, batch);
      });
    } catch (error) {
      if (serverTimeoutSqlState(error) === "55P03") return 0;
      throw error;
    }
  }, batch);
  // History keyed by a plain user id outside the hot path (the agent audit
  // log and the deployment operator audit). A row the drain skipped (locked)
  // or an event written after the drain (a queued audit write, another
  // replica) is taken here, and counts as remaining until it is gone, so the
  // entry is not retired early.
  let plainRemaining = false;
  for (const [table, { userColumn }] of Object.entries(USER_PLAIN_ID_HISTORY_TABLES)) {
    processed += await sweepLoop(
      () => deleteOwnedBatch(db, table, "ctid", userColumn, userId, batch),
      batch,
    );
    const [left] = await db.$queryRaw<[{ remaining: boolean }]>`
      SELECT EXISTS (SELECT 1 FROM ${Prisma.raw(`"${table}"`)}
                      WHERE ${Prisma.raw(`"${userColumn}"`)} = ${userId}) AS remaining`;
    plainRemaining ||= left?.remaining ?? true;
  }
  const [left] = await db.$queryRaw<[{ remaining: boolean }]>`
    SELECT EXISTS (SELECT 1 FROM relay_request WHERE "userId" = ${userId})
        OR EXISTS (SELECT 1 FROM admission_request WHERE "userId" = ${userId})
        OR EXISTS (SELECT 1 FROM response_stickiness_record WHERE "userId" = ${userId})
        OR EXISTS (SELECT 1 FROM cache_affinity_record
                    WHERE "userId" = ${userId} OR "tenantUserId" = ${userId})
        OR EXISTS (SELECT 1 FROM cache_affinity_node
                    WHERE "userId" = ${userId} OR "tenantUserId" = ${userId})
        OR EXISTS (SELECT 1 FROM cache_affinity_residency WHERE "userId" = ${userId})
        OR EXISTS (SELECT 1 FROM cache_affinity_scope WHERE "userId" = ${userId})
        OR EXISTS (SELECT 1 FROM cache_affinity_observer WHERE "userId" = ${userId})
        OR EXISTS (SELECT 1 FROM usage_rollup_minute
                    WHERE "ownerUserId" = ${userId} OR "requesterUserId" = ${userId})
        OR EXISTS (SELECT 1 FROM usage_rollup_hour
                    WHERE "ownerUserId" = ${userId} OR "requesterUserId" = ${userId})
        OR EXISTS (SELECT 1 FROM engine_load_rollup_minute WHERE "ownerUserId" = ${userId})
        OR EXISTS (SELECT 1 FROM node_metrics_minute WHERE "ownerUserId" = ${userId})
        AS remaining`;
  return { processed, remaining: plainRemaining || (left?.remaining ?? true) };
}

/** Bound on the purge's wait for a rollup merge destination held by a hot writer. */
const PURGE_MERGE_LOCK_TIMEOUT_MS = 100;

/**
 * Most queue entries one {@link purgeDeletedUsersHistory} call examines. A clean
 * entry still costs a few dozen cheap statements, so the bound keeps a run
 * short; entries past it wait for a later run (the queue is oldest first).
 */
const PURGE_QUEUE_SCAN_LIMIT = 500;

/**
 * Works through the `deleted_user_purge` queue, oldest first. A user's entry
 * is removed once nothing of theirs is left and
 * {@link DELETED_USER_PURGE_GRACE_MS} has passed since the delete.
 *
 * The queue is read with a `(deletedAt, userId)` keyset cursor, so an entry
 * that is already clean and only waits out the grace period (or that stays
 * blocked by PENDING history) never hides the entries behind it. The call
 * stops after it purged rows of `maxUsers` users, after
 * {@link PURGE_QUEUE_SCAN_LIMIT} examined entries, or at the end of the queue.
 * Entries are removed with SKIP LOCKED, so two sweepers split the removal.
 */
export async function purgeDeletedUsersHistory(
  db: SweepDb,
  {
    now,
    maxUsers = 10,
    batch = HOT_PATH_SWEEP_BATCH,
    graceMs = DELETED_USER_PURGE_GRACE_MS,
  }: { now: Date; maxUsers?: number; batch?: number; graceMs?: number },
): Promise<{ users: number; rows: number; completed: number }> {
  const pageSize = Math.max(1, Math.min(maxUsers, 50));
  let rows = 0;
  let completed = 0;
  let worked = 0;
  let examined = 0;
  let cursor: { userId: string; deletedAt: Date } | null = null;
  while (worked < maxUsers && examined < PURGE_QUEUE_SCAN_LIMIT && !isDbShutdownFenceArmed()) {
    const page: Array<{ userId: string; deletedAt: Date }> = cursor
      ? await db.$queryRaw`
          SELECT "userId", "deletedAt" FROM deleted_user_purge
           WHERE ("deletedAt", "userId") > (${cursor.deletedAt}, ${cursor.userId})
           ORDER BY "deletedAt", "userId"
           LIMIT ${pageSize}`
      : await db.$queryRaw`
          SELECT "userId", "deletedAt" FROM deleted_user_purge
           ORDER BY "deletedAt", "userId"
           LIMIT ${pageSize}`;
    for (const entry of page) {
      if (isDbShutdownFenceArmed() || worked >= maxUsers) break;
      examined += 1;
      cursor = entry;
      const { processed, remaining } = await purgeDeletedUserHistory(db, entry.userId, { batch });
      rows += processed;
      if (processed > 0) worked += 1;
      if (remaining || now.getTime() - entry.deletedAt.getTime() < graceMs) continue;
      completed += await db.$executeRaw`
        DELETE FROM deleted_user_purge
         WHERE "userId" IN (
           SELECT "userId" FROM deleted_user_purge
            WHERE "userId" = ${entry.userId}
              FOR UPDATE SKIP LOCKED)`;
    }
    if (page.length < pageSize) break;
  }
  return { users: examined, rows, completed };
}

/**
 * Invalidates a pool's cache-affinity incarnation for its owner (dashboard action).
 * Takes the pool's cache-affinity fence first, like the affinity writer, so
 * the two serialize and the clear is exact.
 */
export async function clearCacheAffinityRecords(
  db: Pick<PrismaClient, "$transaction">,
  { ownerUserId, poolId }: { ownerUserId: string; poolId: string },
): Promise<{ cleared: true; reclamation: "pending" }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET LOCAL statement_timeout = '1000ms'`;
          await tx.$executeRaw`SET LOCAL lock_timeout = '100ms'`;
          await acquireFences(tx, [fences.cacheAffinity(ownerUserId, poolId)]);
          await tx.$executeRaw`INSERT INTO cache_affinity_scope ("poolId", "userId", generation, "reclaimPending")
              VALUES (${poolId}, ${ownerUserId}, ${randomUUID()}, true)
              ON CONFLICT ("poolId") DO UPDATE SET generation = EXCLUDED.generation, "reclaimPending" = true
              WHERE cache_affinity_scope."userId" = EXCLUDED."userId"`;
          return { cleared: true, reclamation: "pending" } as const;
        },
        { maxWait: 1000, timeout: 2500 },
      );
    } catch (error) {
      if (attempt >= 3 || !["55P03", "40P01"].includes(serverTimeoutSqlState(error) ?? ""))
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
}

/** One independently committed batch. A scope epoch is the logical clear receipt. */
export async function reclaimClearedAffinity(
  db: SweepDb,
  { poolId, ownerUserId, limit = 256 }: { poolId: string; ownerUserId: string; limit?: number },
): Promise<number> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET LOCAL statement_timeout = '1000ms'`;
      await tx.$executeRaw`SET LOCAL lock_timeout = '100ms'`;
      await acquireFences(tx, [fences.cacheAffinity(ownerUserId, poolId)]);
      const [scope] = await tx.$queryRaw<Array<{ generation: string }>>`
      SELECT generation FROM cache_affinity_scope WHERE "poolId" = ${poolId}
        AND "userId" = ${ownerUserId} AND "reclaimPending" FOR UPDATE`;
      if (!scope) return 0;
      const batch = Math.max(1, Math.min(256, limit));
      await tx.$executeRaw`SET LOCAL enable_bitmapscan = off`;
      let removed = 0;
      let remaining = false;
      for (const table of ["cache_affinity_record", "cache_affinity_node"]) {
        let tableRemoved = 0;
        // Two indexed ranges skip the potentially very large current incarnation.
        // A <> filter alone can walk all fresh rows just to prove old work absent.
        for (const operator of ["<", ">"] as const) {
          tableRemoved += await tx.$executeRaw(Prisma.sql`
        DELETE FROM ${Prisma.raw(table)} WHERE id = ANY(ARRAY(
          SELECT id FROM ${Prisma.raw(table)} WHERE "userId" = ${ownerUserId} AND "poolId" = ${poolId}
            AND split_part("cacheGeneration", ':pool:', 2) ${Prisma.raw(operator)} ${scope.generation}
          ORDER BY split_part("cacheGeneration", ':pool:', 2), id LIMIT ${batch - tableRemoved} FOR UPDATE SKIP LOCKED))`);
          const [state] = await tx.$queryRaw<Array<{ remaining: boolean }>>(Prisma.sql`
            SELECT EXISTS(SELECT 1 FROM ${Prisma.raw(table)} WHERE "userId" = ${ownerUserId}
              AND "poolId" = ${poolId} AND split_part("cacheGeneration", ':pool:', 2)
                ${Prisma.raw(operator)} ${scope.generation} LIMIT 1) AS remaining`);
          remaining ||= state?.remaining === true;
        }
        removed += tableRemoved;
      }
      if (!remaining) {
        await tx.$executeRaw`UPDATE cache_affinity_scope SET "reclaimPending" = false
        WHERE "poolId" = ${poolId} AND generation = ${scope.generation}`;
      }
      return removed;
    },
    { maxWait: 1000, timeout: 2500 },
  );
}
