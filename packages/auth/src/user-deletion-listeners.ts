/**
 * Post-commit user-deletion notifications.
 *
 * Every path that deletes a `User` row reports it here once the delete has
 * committed. All of them go through the durable, bounded delete in
 * `@ws-model-proxy/db/parent-deletion` (`deleteUserDurably`), which returns
 * "deleted" only after the ordered transaction that removes the user row
 * committed:
 *  - Better Auth (`/admin/remove-user`, and the self-service delete-user
 *    routes when enabled) through `databaseHooks.user.delete.before`, which
 *    performs the delete itself and declines Better Auth's own DELETE (so
 *    Better Auth runs no `delete.after`);
 *  - the dashboard `users.remove` procedure;
 *  - the user-deletion sweeper (apps/server/src/user-deletion-sweep.ts),
 *    which finishes a delete whose completion failed transiently.
 * A pending delete notifies nothing until the sweeper completes it.
 *
 * The server subscribes its relay session manager, which closes every live
 * relay socket whose authenticated identity belongs to the deleted user.
 * Matching is by `identity.userId`, not by a snapshot of credential ids, so a
 * credential minted between any snapshot and the delete is covered too.
 *
 * In-process only: listeners run in the replica that performed the delete.
 * Sockets held by another replica are not reached here; their credential rows
 * cascade with the user, so that replica refuses them at the next hello or
 * inventory update (registration re-reads the credential) and websocket auth
 * refuses any reconnect.
 */

export type UserDeletedListener = (userId: string) => void | Promise<void>;

const listeners = new Set<UserDeletedListener>();
const markedListeners = new Set<UserDeletedListener>();

/** Subscribes a listener; returns its unsubscribe function. Idempotent per function. */
export function onUserDeleted(listener: UserDeletedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Fires after durable deletion intent is recorded (ban, sessions revoked). */
export function onUserDeletionMarked(listener: UserDeletedListener): () => void {
  markedListeners.add(listener);
  return () => {
    markedListeners.delete(listener);
  };
}

export async function notifyUserDeletionMarked(userId: string): Promise<void> {
  for (const listener of [...markedListeners]) {
    try {
      await listener(userId);
    } catch (error) {
      console.error(
        "[auth] user deletion marked listener failed",
        error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
      );
    }
  }
}

/**
 * Runs every listener for a committed user delete. A listener failure is
 * logged (class only) and never thrown: the delete already happened and must
 * not be reported as failed.
 */
export async function notifyUserDeleted(userId: string): Promise<void> {
  for (const listener of [...listeners]) {
    try {
      await listener(userId);
    } catch (error) {
      console.error(
        "[auth] user deletion listener failed",
        error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
      );
    }
  }
}
