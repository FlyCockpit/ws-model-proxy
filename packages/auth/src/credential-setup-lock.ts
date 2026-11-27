import type { Prisma } from "@ws-model-proxy/db";
import { fenceOwners } from "@ws-model-proxy/db/capacity-lock-order";

/** Better Auth's verification identifier prefix for password-reset tokens (invite links too). */
export const RESET_PASSWORD_IDENTIFIER_PREFIX = "reset-password:";

/**
 * Marks an account an admin invited: identifier `admin-invited:<userId>`, value the user id,
 * written once by `users.invite` right after it created the account, before its first link
 * (packages/api lib/set-password-link.ts markAdminInvited), and never deleted. Every link,
 * resends included, requires it, so an unverified public sign-up never becomes an invite, and a
 * link shown to the admin is spendable only while the marked account is a pending invite
 * (password-reset-links.ts `isInvitePending`, checked at redemption). Spending a link verifies
 * and proves the address only when that link was mailed (password-reset-links.ts); without SMTP,
 * spending a marked account's link activates it in the reset transaction and proves nothing.
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
 * mints a set-password link, records one as mailed, checks a shown one at redemption, finishes a
 * password reset or cleans up after an activation, until the calling transaction ends. Minting
 * (packages/api lib/set-password-link.ts) re-checks under it that the invite is still pending; a
 * finished reset (the selective adapter, with callback cleanup as defense) and an activation
 * (account-activation.ts) delete every other reset link under it. So a resend racing the
 * invitee's own password setup either sees the account active and refuses, or mints a link the
 * reset or activation then deletes; and a shown link that outlived the activation anyway is
 * refused when spent (password-reset-links.ts `isResetLinkRedeemable`).
 *
 * The HTTP password-write lock now surrounds reset token consumption, the
 * password write, and finalization. It precedes this owner fence. This IS
 * the credential fence too: no second per-user setup advisory lock exists.
 */
export async function lockCredentialSetup(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  await fenceOwners(tx, [userId]);
}
