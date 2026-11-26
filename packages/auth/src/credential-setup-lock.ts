import type { Prisma } from "@ws-model-proxy/db";
import { fenceOwners } from "@ws-model-proxy/db/capacity-lock-order";

/** Better Auth's verification identifier prefix for password-reset tokens (invite links too). */
export const RESET_PASSWORD_IDENTIFIER_PREFIX = "reset-password:";

/**
 * Marks an account an admin invited: identifier `admin-invited:<userId>`, value the user id,
 * written once by `users.invite` right after it created the account, before its first link
 * (packages/api lib/set-password-link.ts markAdminInvited), and never deleted. Every link,
 * resends included, requires it, so an unverified public sign-up never becomes an invite. Spending a reset link verifies the email only on such an account (`onPasswordReset`):
 * an invite is created unverified and its link is the only way in. A reset never records WMP's
 * mailbox proof (`provedEmail`, pool-share acceptance): only verify-email does, because Better
 * Auth does not tell `onPasswordReset` which link was spent and an invite link may have been
 * shown to the admin. A public sign-up's forgot-password reset leaves `emailVerified` alone, so
 * it still verifies (and proves) its address through verify-email.
 *
 * A verification row because the schema has no column for it (a column is the better home once
 * a migration is due); it expires never ({@link ADMIN_INVITED_EXPIRES_AT}), so Better Auth's
 * expired-verification cleanup cannot drop it.
 */
export const ADMIN_INVITED_PREFIX = "admin-invited:";

/** "Never" for the admin-invited mark. */
export const ADMIN_INVITED_EXPIRES_AT = new Date("9999-12-31T00:00:00.000Z");

/**
 * Serializes, per user (through the user's `owner` fence: the app's one advisory-lock protocol,
 * packages/db capacity-lock-order.ts; taken first and alone, as M writers do), everything that
 * mints a set-password link or finishes a password reset, until the calling transaction ends. Minting (packages/api lib/set-password-link.ts) re-checks
 * under it that the invite is still pending; a finished reset (`onPasswordReset`) marks an
 * invited account's email verified and deletes every other reset link under it. So a resend racing the invitee's own
 * password setup either sees the account verified and refuses, or mints a link the reset then
 * deletes: no working link to an activated account is ever left behind.
 *
 * A known residual: Better Auth spends a reset token (and writes the password) before
 * `onPasswordReset` takes this lock, so a resend landing in that gap can mint one more link that
 * the callback deletes a moment later. That link reaches only the invitee's own mailbox or, when
 * it cannot be mailed, the human admin who asked for it, and an admin can already set any user's
 * password (`/api/auth/admin/set-user-password`): the gap grants nobody anything new.
 */
export async function lockCredentialSetup(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  await fenceOwners(tx, [userId]);
}
