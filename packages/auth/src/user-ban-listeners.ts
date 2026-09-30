/**
 * Post-commit user-ban notifications (#159).
 *
 * Every path that sets an ACTIVE ban on a `User` row reports it here once the
 * write has committed, so in-memory work the ban must end is cancelled instead
 * of running to completion or its timeout:
 *  - Better Auth (`/admin/ban-user`, and any `/admin/update-user` that sets
 *    `banned`) through `databaseHooks.user.update.after`, which Better Auth runs
 *    after the update's transaction committed (./index.ts);
 *  - the dashboard `users.archive` procedure, which writes the ban with Prisma
 *    directly (packages/api/src/routers/users.ts).
 * A deletion mark also bans, but it has its own notification
 * (./user-deletion-listeners.ts) that closes the user's sockets, which ends the
 * same work. An unban, or a ban whose expiry has passed, notifies nothing.
 *
 * The server subscribes the relay: it cancels the user's in-flight file ops and
 * commands and refuses admissions still reading (apps/server/src/app.ts).
 *
 * In-process only: listeners run in the replica that performed the write.
 * Another replica refuses the banned user's next admission (every relay
 * admission re-reads the owner's ban state) and ends an op at its deadline.
 */

export type UserBannedListener = (userId: string) => void | Promise<void>;

const listeners = new Set<UserBannedListener>();

/** Subscribes a listener; returns its unsubscribe function. Idempotent per function. */
export function onUserBanned(listener: UserBannedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Runs every listener for a committed ban. A listener failure is logged (class
 * only) and never thrown, and never stops the listeners after it: the ban
 * already happened and must not be reported as failed.
 */
export async function notifyUserBanned(userId: string): Promise<void> {
  for (const listener of [...listeners]) {
    try {
      await listener(userId);
    } catch (error) {
      console.error(
        "[auth] user banned listener failed",
        error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
      );
    }
  }
}
