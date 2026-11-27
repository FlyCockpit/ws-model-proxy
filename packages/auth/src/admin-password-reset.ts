import { revokeUserCredentials } from "./credential-revocation";
import { assertPasswordWriteLocked, passwordWriteLockUserId } from "./password-write-lock";

const authorizedWrites = new WeakSet<object>();

/** Called ONLY by password-bearing account hooks, after upstream admin authorization. */
export async function secureAdminPasswordReset(
  context: { path?: string } | null | undefined,
  userId?: string,
): Promise<void> {
  if (context?.path !== "/admin/set-user-password") return;
  assertPasswordWriteLocked(userId);
  await revokeUserCredentials(passwordWriteLockUserId());
  if (context) authorizedWrites.add(context);
}

/** updateMany.after receives a count, not an account. Use the authorized before-hook evidence. */
export async function finishAdminPasswordReset(context: object | null | undefined): Promise<void> {
  if (!context || !authorizedWrites.has(context)) return;
  authorizedWrites.delete(context);
  assertPasswordWriteLocked();
  await revokeUserCredentials(passwordWriteLockUserId());
}
