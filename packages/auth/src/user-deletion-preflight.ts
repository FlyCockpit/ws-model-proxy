/**
 * Records durable deletion intent before Better Auth deletes a user's sessions and accounts.
 *
 * Better Auth's `/admin/remove-user` (and the self-service delete-user routes, which are not
 * enabled) delete the user's sessions and accounts first and only then reach
 * `databaseHooks.user.delete.before`, where the durable delete runs (see ./index.ts and
 * @ws-model-proxy/db/parent-deletion). On a user-delete route this hook marks the user
 * ({@link requestUserDeletion}) before the first session or account row is removed, so a
 * delete that fails later is finished by the user-deletion sweeper instead of leaving a user
 * with no sessions and no accounts. 0.4.0 has no retained-history refusal: the drain removes
 * the user's spend history too, and running instances are released by the cascade.
 */
import prisma from "@ws-model-proxy/db";
import { requestUserDeletion } from "@ws-model-proxy/db/parent-deletion";

import { notifyUserDeletionMarked } from "./user-deletion-listeners";

/** Better Auth routes that delete a user after its sessions and accounts. */
export const USER_DELETE_PATHS: ReadonlySet<string> = new Set([
  "/admin/remove-user",
  "/delete-user",
  "/delete-user/callback",
]);

/**
 * `delete.before` for Better Auth's `session` and `account` models: on a user-delete route,
 * marks the user before the first row is deleted. A no-op elsewhere (sign-out, session
 * revocation, account unlinking).
 */
export async function refuseUndeletableUserBeforeCredentialDelete(
  row: { userId: string },
  context: { path?: string } | null | undefined,
): Promise<void> {
  if (!context?.path || !USER_DELETE_PATHS.has(context.path)) return;
  // Idempotent: the first call starts the deletion generation (and notifies), later calls
  // for the same delete keep it.
  const mark = await requestUserDeletion(prisma, row.userId);
  if (mark?.created) await notifyUserDeletionMarked(row.userId);
}
