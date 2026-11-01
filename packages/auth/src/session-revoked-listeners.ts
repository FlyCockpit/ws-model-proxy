/**
 * Post-commit session deletion notifications (security audit 2026-10-31, finding 2).
 *
 * Better Auth runs `databaseHooks.session.delete.after` for every session row it deletes,
 * once the delete's transaction committed (./index.ts): a sign-out, "sign out other
 * sessions", a revoke from the sessions list, a password reset that revokes sessions, and the
 * admin plugin's ban and revoke routes. Each row is reported here, so in-memory work bound to
 * that session (browser terminal sockets) ends at once instead of at the next 60 s recheck.
 *
 * Paths that delete sessions with Prisma directly have their own notifications: a ban
 * (./user-ban-listeners.ts, `users.archive`) and a deletion mark
 * (./user-deletion-listeners.ts). Expired sessions are swept without one; every holder
 * re-checks expiry itself.
 *
 * In-process only: listeners run in the replica that performed the delete. Another replica
 * refuses the session at its next open or attach (each re-reads the session) and closes the
 * socket at its 60 s recheck.
 */

export type SessionRevokedListener = (session: {
  id: string;
  userId: string;
}) => void | Promise<void>;

const listeners = new Set<SessionRevokedListener>();

/** Subscribes a listener; returns its unsubscribe function. Idempotent per function. */
export function onSessionRevoked(listener: SessionRevokedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Runs every listener for a committed session delete. A listener failure is logged (class
 * only) and never thrown, and never stops the listeners after it: the session is gone and the
 * delete must not be reported as failed.
 */
export async function notifySessionRevoked(session: { id: string; userId: string }): Promise<void> {
  for (const listener of [...listeners]) {
    try {
      await listener(session);
    } catch (error) {
      console.error(
        "[auth] session revoked listener failed",
        error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
      );
    }
  }
}
