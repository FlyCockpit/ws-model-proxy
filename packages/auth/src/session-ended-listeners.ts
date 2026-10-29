/**
 * Post-commit dashboard session ends (#255).
 *
 * Better Auth deletes a session row on sign-out, on a revoked session ("revoke session",
 * "revoke other sessions", "revoke all sessions") and when an admin stops impersonating; its
 * `databaseHooks.session.delete.after` reports each deleted row here once the delete committed
 * (./index.ts). Expired rows that are never deleted are left to each consumer's own session
 * recheck.
 *
 * The server subscribes the browser sockets opened with a session (node event streams,
 * terminals), so they close at once instead of at their next recheck (apps/server/src/app.ts).
 *
 * In-process only: listeners run in the replica that performed the delete. Another replica's
 * sockets close at their next recheck, which reads the missing row.
 */

export type SessionEndedListener = (session: { id: string; userId: string }) => void;

const listeners = new Set<SessionEndedListener>();

/** Subscribes a listener; returns its unsubscribe function. Idempotent per function. */
export function onSessionEnded(listener: SessionEndedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Runs every listener for a deleted session. A listener failure is logged (class only) and
 * never thrown: the sign-out already happened and must not be reported as failed.
 */
export function notifySessionEnded(session: { id: string; userId: string }): void {
  for (const listener of [...listeners]) {
    try {
      listener(session);
    } catch (error) {
      console.error(
        "[auth] session ended listener failed",
        error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
      );
    }
  }
}
