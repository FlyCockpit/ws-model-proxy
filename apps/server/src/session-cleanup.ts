/**
 * Bounded retention cleanup for expired Better Auth browser sessions.
 *
 * Each batch reads only IDs and deletes those exact IDs while reasserting the
 * same expiry predicate. This is safe across replicas and against a concurrent
 * session extension: a concurrent delete becomes a count-zero no-op, while a
 * session whose expiry is moved forward no longer matches the delete predicate.
 * No lock is held across the read/delete await boundary.
 *
 * This job owns no durable work at shutdown. Its only durable intent is the
 * already-persisted expiry state, so it deliberately has no shutdown permit:
 * stop() prevents future scheduling and the DB shutdown fence stops new batches.
 * A later process re-runs the same idempotent predicate over any remaining rows.
 */
import defaultPrisma from "@ws-model-proxy/db";
import { isDbShutdownFenceArmed } from "@ws-model-proxy/db/shutdown-fence";

type SessionCleanupPrisma = Pick<typeof defaultPrisma, "session">;

/** Hourly retention cadence, matching the other in-process cleanup jobs. */
export const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
/** Bounds rows read, deleted, and locked by one statement. */
export const SESSION_CLEANUP_BATCH = 500;

/**
 * Remove expired sessions in state-predicated batches. The inclusive boundary
 * means a session expiring exactly at `now` is eligible. Returns rows deleted.
 */
export async function sweepExpiredSessions({
  prisma = defaultPrisma as SessionCleanupPrisma,
  now = new Date(),
}: {
  prisma?: SessionCleanupPrisma;
  now?: Date;
} = {}): Promise<number> {
  const where = { expiresAt: { lte: now } };
  let removed = 0;

  for (;;) {
    // Ordinary fenced work: after shutdown starts, leave the residual for the
    // next process rather than opening another DB operation during teardown.
    if (isDbShutdownFenceArmed()) return removed;

    const rows = await prisma.session.findMany({
      where,
      select: { id: true },
      take: SESSION_CLEANUP_BATCH,
    });
    if (rows.length === 0) return removed;

    const { count } = await prisma.session.deleteMany({
      where: { ...where, id: { in: rows.map((row) => row.id) } },
    });
    removed += count;

    // A short read drained the current predicate. A full count-zero delete
    // means another replica won the race; break rather than spin on it.
    if (rows.length < SESSION_CLEANUP_BATCH || count === 0) return removed;
  }
}

// One scheduler per process. A stale stop handle cannot release a newer
// scheduler's slot, and an in-flight sweep is guarded so intervals never overlap.
let activeSessionCleanupStop: (() => void) | null = null;

export function startSessionCleanup({
  intervalMs = SESSION_CLEANUP_INTERVAL_MS,
  sweep = sweepExpiredSessions,
}: {
  intervalMs?: number;
  sweep?: typeof sweepExpiredSessions;
} = {}): () => void {
  if (activeSessionCleanupStop !== null) return activeSessionCleanupStop;

  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const removed = await sweep();
      if (removed > 0) console.log(`[auth] session cleanup removed ${removed} expired session(s).`);
    } catch (error) {
      // Prisma failures can contain SQL and parameters. Keep retention errors
      // observable without exposing database details in the process log.
      console.error(
        "[auth] session cleanup sweep failed:",
        error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
      );
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref?.();
  const stop = () => {
    clearInterval(timer);
    if (activeSessionCleanupStop === stop) activeSessionCleanupStop = null;
  };
  activeSessionCleanupStop = stop;
  return stop;
}
