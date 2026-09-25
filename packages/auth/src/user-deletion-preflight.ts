/**
 * Refuses a Better Auth user delete before it changes anything when the
 * user's retained history (ON DELETE RESTRICT: capacity leases, provider
 * accounting) makes the delete fail.
 *
 * Better Auth's `/admin/remove-user` (and the self-service delete-user
 * routes, which are not enabled) delete the user's sessions and accounts
 * first and only then reach `databaseHooks.user.delete.before`, where the
 * durable delete runs (see ./index.ts and @ws-model-proxy/db/parent-deletion).
 * A refusal raised there would leave a user with no sessions and no accounts
 * behind an error. On a user-delete route this hook records durable deletion
 * intent ({@link requestUserDeletion}) before the first session or account
 * row is removed, then runs the retained-history preflight on every hook
 * invocation so a delete that cannot succeed is refused while the marker
 * (and ban) remain for the sweeper.
 *
 * The preflight inside the user delete still runs (a lease can appear between
 * the two); that race is the remaining way to strand a user, recorded in the
 * release notes.
 */
import prisma from "@ws-model-proxy/db";
import {
  findRetainedHistoryBlocker,
  RetainedHistoryError,
  requestUserDeletion,
  resolveDeletedParents,
} from "@ws-model-proxy/db/parent-deletion";
import { APIError } from "better-auth/api";

import { notifyUserDeletionMarked } from "./user-deletion-listeners";

/** Better Auth routes that delete a user after its sessions and accounts. */
export const USER_DELETE_PATHS: ReadonlySet<string> = new Set([
  "/admin/remove-user",
  "/delete-user",
  "/delete-user/callback",
]);

export const RETAINED_HISTORY_REMOVE_USER_MESSAGE =
  "This user has retained history and cannot be deleted. Archive them instead.";

/**
 * `delete.before` for Better Auth's `session` and `account` models: on a
 * user-delete route, throws a CONFLICT before the first row is deleted when
 * the user's retained history would fail the delete. A no-op elsewhere
 * (sign-out, session revocation, account unlinking).
 */
export async function refuseUndeletableUserBeforeCredentialDelete(
  row: { userId: string },
  context: { path?: string } | null | undefined,
): Promise<void> {
  if (!context?.path || !USER_DELETE_PATHS.has(context.path)) return;
  const blocker = await findRetainedHistoryBlocker(
    prisma,
    await resolveDeletedParents(prisma, { userId: row.userId, wholeUser: true }),
  );
  if (blocker)
    throw new APIError("CONFLICT", {
      message: RETAINED_HISTORY_REMOVE_USER_MESSAGE,
      code: "RETAINED_HISTORY",
      cause: new RetainedHistoryError(blocker),
    });
  // Idempotent: the first call starts the deletion generation (and notifies),
  // later calls for the same delete keep it.
  const mark = await requestUserDeletion(prisma, row.userId);
  if (mark?.created) await notifyUserDeletionMarked(row.userId);
}
