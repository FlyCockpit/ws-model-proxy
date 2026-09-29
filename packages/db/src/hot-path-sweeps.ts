/**
 * Sweepers over the hot-path (writer class H) tables, DL-1 design (d) (#78).
 *
 * H tables reference graph rows (users, pools, targets, capacities) by plain
 * id, with no foreign key (./capacity-lock-order.ts). A graph delete therefore
 * leaves their rows behind; these sweepers (writer class S) clean them up.
 * Every statement takes its rows with SKIP LOCKED and none takes a fence, so
 * a sweep never waits on a lock: a busy row is left for the next run.
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
import type { PrismaClient } from "../prisma/generated/client";
import { Prisma } from "../prisma/generated/client";
import {
  acquireFences,
  deleteTerminalRelayRequestsWithoutWaiting,
  fences,
} from "./capacity-lock-order";
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
        DELETE FROM admission_request WHERE id = ANY(${eligible}::text[])`;
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
  for (const column of ["userId", "tenantUserId"])
    processed += await sweepLoop(
      () => deleteOwnedBatch(db, "cache_affinity_record", "id", column, userId, batch),
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
  for (const table of ["usage_rollup_minute", "usage_rollup_hour"])
    processed += await sweepLoop(
      () => deleteOwnedBatch(db, table, "ctid", "ownerUserId", userId, batch),
      batch,
    );
  processed += await sweepLoop(
    () => db.$transaction((tx) => drainRequesterUsageRollupsBatch(tx, userId, batch)),
    batch,
  );
  const [left] = await db.$queryRaw<[{ remaining: boolean }]>`
    SELECT EXISTS (SELECT 1 FROM relay_request WHERE "userId" = ${userId})
        OR EXISTS (SELECT 1 FROM admission_request WHERE "userId" = ${userId})
        OR EXISTS (SELECT 1 FROM response_stickiness_record WHERE "userId" = ${userId})
        OR EXISTS (SELECT 1 FROM cache_affinity_record
                    WHERE "userId" = ${userId} OR "tenantUserId" = ${userId})
        OR EXISTS (SELECT 1 FROM usage_rollup_minute
                    WHERE "ownerUserId" = ${userId} OR "requesterUserId" = ${userId})
        OR EXISTS (SELECT 1 FROM usage_rollup_hour
                    WHERE "ownerUserId" = ${userId} OR "requesterUserId" = ${userId})
        AS remaining`;
  return { processed, remaining: left?.remaining ?? true };
}

/**
 * Works through the `deleted_user_purge` queue, oldest first, at most
 * `maxUsers` users per call. A user's entry is removed once nothing of theirs
 * is left and {@link DELETED_USER_PURGE_GRACE_MS} has passed since the delete.
 * Queue entries are taken with SKIP LOCKED, so two sweepers split the queue.
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
  const queue = await db.$queryRaw<Array<{ userId: string; deletedAt: Date }>>`
    SELECT "userId", "deletedAt" FROM deleted_user_purge
     ORDER BY "deletedAt", "userId"
     LIMIT ${maxUsers}`;
  let rows = 0;
  let completed = 0;
  for (const entry of queue) {
    if (isDbShutdownFenceArmed()) break;
    const { processed, remaining } = await purgeDeletedUserHistory(db, entry.userId, { batch });
    rows += processed;
    if (remaining || now.getTime() - entry.deletedAt.getTime() < graceMs) continue;
    completed += await db.$executeRaw`
      DELETE FROM deleted_user_purge
       WHERE "userId" IN (
         SELECT "userId" FROM deleted_user_purge
          WHERE "userId" = ${entry.userId}
            FOR UPDATE SKIP LOCKED)`;
  }
  return { users: queue.length, rows, completed };
}

/**
 * Clears a pool's cache-affinity records for its owner (dashboard action).
 * Takes the pool's cache-affinity fence first, like the affinity writer, so
 * the two serialize and the clear is exact.
 */
export async function clearCacheAffinityRecords(
  db: Pick<PrismaClient, "$transaction">,
  { ownerUserId, poolId }: { ownerUserId: string; poolId: string },
): Promise<number> {
  return db.$transaction(async (tx) => {
    await acquireFences(tx, [fences.cacheAffinity(ownerUserId, poolId)]);
    const result = await tx.cacheAffinityRecord.deleteMany({
      where: { userId: ownerUserId, poolId },
    });
    return result.count;
  });
}
