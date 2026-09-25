/**
 * Finishes accepted user deletions (DL1-TXBOUND durable intent).
 *
 * `users.remove` and Better Auth's remove-user mark the user
 * (`deletionRequestedAt`, a ban, sessions revoked) before draining its request
 * history and deleting its capacity graph (@ws-model-proxy/db/parent-deletion).
 * When that completion fails transiently, or the process stops mid-drain, the
 * marker survives. This sweep resumes every marked user: the drain is
 * idempotent (only rows still present are processed) and the ordered delete
 * re-plans under its own locks, so resuming after any crash point is safe.
 *
 * Outcomes per user:
 *  - deleted: listeners are notified (live relay sessions of the user close);
 *  - already gone: nothing to do (the marker went with the row);
 *  - permanent refusal (retained history appeared after the preflight, or a
 *    database invariant refused the delete): the marker is cleared and the
 *    user is archived (an indefinite ban set in the same statement,
 *    `abandonUserDeletion`), the fallback the refusal recommends;
 *  - transient failure, or a residual above the final-phase bound found by
 *    the in-transaction recount: logged, retried after an exponential backoff
 *    (per generation attempt count) so other pending users get a turn.
 *
 * Concurrency: a sweep and a request (or two replicas) completing the same
 * user interleave safely. Drain batches take rows with SKIP LOCKED, the
 * ordered delete serializes on the user row, and the loser finds the user
 * gone. The grace period keeps the sweep from joining a request that is
 * still completing the delete itself.
 *
 * Shutdown: no permit. Stopping the sweep (the first shutdown step) prevents
 * any further user from being started by it: the stop flag is checked before
 * every user and before a tick begins. The user already in progress runs on
 * until the DB shutdown fence stops its drain between batches (or its ordered
 * transaction commits or rolls back); shutdown joins that in-flight tick,
 * bounded, before Prisma disconnects. The marker keeps the rest for the next
 * process.
 */
import { notifyUserDeleted } from "@ws-model-proxy/auth/user-deletion-listeners";
import defaultPrisma from "@ws-model-proxy/db";
import {
  abandonUserDeletion,
  completeUserDeletion,
  isPermanentParentDeletionFailure,
  listPendingUserDeletions,
  recordUserDeletionSweepFailure,
} from "@ws-model-proxy/db/parent-deletion";
import { isDbShutdownFenceArmed } from "@ws-model-proxy/db/shutdown-fence";

export const USER_DELETION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/** A marker younger than this is still being completed by its request. */
export const USER_DELETION_SWEEP_GRACE_MS = 2 * 60 * 1000;
/** Users completed per tick; the rest wait for the next tick. */
export const USER_DELETION_SWEEP_BATCH = 10;

type SweepPrisma = Parameters<typeof completeUserDeletion>[0];

export type UserDeletionSweepResult = {
  deleted: number;
  abandoned: number;
  failed: number;
};

function errorClass(error: unknown): string {
  return error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error;
}

export async function sweepPendingUserDeletions({
  prisma = defaultPrisma as SweepPrisma,
  now = new Date(),
  complete = completeUserDeletion,
  notify = notifyUserDeleted,
  shouldStop = () => false,
}: {
  prisma?: SweepPrisma;
  now?: Date;
  complete?: typeof completeUserDeletion;
  notify?: (userId: string) => Promise<void>;
  /** True once shutdown began: no further user is started. */
  shouldStop?: () => boolean;
} = {}): Promise<UserDeletionSweepResult> {
  const result: UserDeletionSweepResult = { deleted: 0, abandoned: 0, failed: 0 };
  const pending = await listPendingUserDeletions(prisma, {
    before: new Date(now.getTime() - USER_DELETION_SWEEP_GRACE_MS),
    limit: USER_DELETION_SWEEP_BATCH,
    now,
  });
  // Every transition below acts on the generation this sweep selected: a
  // deletion abandoned and requested again meanwhile is left to its own
  // generation (completion returns false, abandon and backoff match nothing).
  for (const { userId, generation, attempts } of pending) {
    if (shouldStop() || isDbShutdownFenceArmed()) break;
    try {
      if (await complete(prisma, userId, generation)) {
        result.deleted += 1;
        await notify(userId);
      }
    } catch (error) {
      if (isPermanentParentDeletionFailure(error)) {
        if (await abandonUserDeletion(prisma, userId, generation)) result.abandoned += 1;
        console.error("[auth] user deletion refused; the user stays archived:", errorClass(error));
      } else {
        result.failed += 1;
        await recordUserDeletionSweepFailure(prisma, userId, generation, {
          now,
          attempt: attempts + 1,
        });
        console.error("[auth] user deletion sweep will retry:", errorClass(error));
      }
    }
  }
  return result;
}

/**
 * Stops the sweep: no tick and no user starts afterwards. Resolves when the
 * tick in flight (if any) has finished.
 */
export type StopUserDeletionSweep = () => Promise<void>;

let activeUserDeletionSweepStop: StopUserDeletionSweep | null = null;

export function startUserDeletionSweep({
  intervalMs = USER_DELETION_SWEEP_INTERVAL_MS,
  sweep = sweepPendingUserDeletions,
}: {
  intervalMs?: number;
  sweep?: typeof sweepPendingUserDeletions;
} = {}): StopUserDeletionSweep {
  if (activeUserDeletionSweepStop !== null) return activeUserDeletionSweepStop;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  const tick = async () => {
    try {
      const result = await sweep({ shouldStop: () => stopped });
      if (result.deleted + result.abandoned > 0)
        console.log(
          `[auth] user deletion sweep: deleted ${result.deleted}, archived ${result.abandoned} after a refusal.`,
        );
    } catch (error) {
      console.error("[auth] user deletion sweep failed:", errorClass(error));
    }
  };
  const run = () => {
    if (stopped || inFlight !== null) return;
    inFlight = tick().finally(() => {
      inFlight = null;
    });
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  const stop: StopUserDeletionSweep = async () => {
    stopped = true;
    clearInterval(timer);
    if (activeUserDeletionSweepStop === stop) activeUserDeletionSweepStop = null;
    await inFlight;
  };
  activeUserDeletionSweepStop = stop;
  return stop;
}
