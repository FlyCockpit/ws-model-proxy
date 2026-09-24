/**
 * Post-commit user-deletion notifications.
 *
 * Every path that deletes a `User` row reports it here once the delete has
 * committed:
 *  - Better Auth (`/admin/remove-user`, and the self-service delete-user
 *    routes when enabled) through `databaseHooks.user.delete.after`, which
 *    Better Auth queues until its transaction commits;
 *  - the dashboard `users.remove` procedure, which deletes through Prisma
 *    directly and calls `notifyUserDeleted` after the delete resolves.
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

/** Subscribes a listener; returns its unsubscribe function. Idempotent per function. */
export function onUserDeleted(listener: UserDeletedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
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
