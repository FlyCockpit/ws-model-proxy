import { randomBytes } from "node:crypto";
import { auth } from "@ws-model-proxy/auth";
import {
  ADMIN_INVITED_EXPIRES_AT,
  ADMIN_INVITED_PREFIX,
  lockCredentialSetup,
  RESET_PASSWORD_IDENTIFIER_PREFIX,
} from "@ws-model-proxy/auth/credential-setup-lock";
import {
  CREDENTIAL_PROVIDER_ID,
  isInvitePending,
  readInviteState,
} from "@ws-model-proxy/auth/password-reset-links";
import { DEFAULT_LOCALE, isSupportedLocale } from "@ws-model-proxy/config/locales";
import prisma from "@ws-model-proxy/db";
import { env } from "@ws-model-proxy/env/server";

/**
 * How long an admin-invite set-password link stays valid. Longer than a
 * forgot-password link (Better-Auth's 1-hour default, unchanged): an invite
 * often sits in an inbox over a weekend. Single-use either way, and re-sending
 * the invite kills the previous link.
 */
export const INVITE_LINK_TTL_SECONDS = 7 * 24 * 60 * 60;
export const INVITE_LINK_TTL_DAYS = INVITE_LINK_TTL_SECONDS / (24 * 60 * 60);

/**
 * The user signs in through another provider (an SSO/OIDC account is linked).
 * A set-password link would let whoever holds it add a password next to that
 * identity — a second way in that skips the IdP and its MFA — so none is minted.
 */
export class SetPasswordLinkRefusedError extends Error {
  constructor() {
    super("This user signs in with another provider; no set-password link was created.");
    this.name = "SetPasswordLinkRefusedError";
  }
}

/**
 * The account is no longer a pending invite (packages/auth password-reset-links.ts
 * `isInvitePending`: verified, signed in, or not an admin invite at all) by the time the link
 * would be written, so none is minted. Checked under the same per-user lock a finished reset and
 * an activation take, so a resend that raced the setup cannot leave a working link to an
 * activated account.
 */
export class SetPasswordLinkNotPendingError extends Error {
  constructor() {
    super("This user has already set up their account; no set-password link was created.");
    this.name = "SetPasswordLinkNotPendingError";
  }
}

/**
 * Mint a one-time "set your password" link for an admin-invited user.
 *
 * This is Better-Auth's own password-reset machinery with a longer expiry: the
 * token is a `reset-password:<token>` verification row (exactly what
 * `requestPasswordReset` writes), so the emailed link goes through Better-Auth's
 * `GET /api/auth/reset-password/:token` validation and redirect, and the web
 * `/$lang/reset-password` page spends it with `authClient.resetPassword`. That
 * keeps every reset-side guarantee — single use, session revocation, the
 * mailed-link email verification — with no
 * second password-setting path.
 *
 * Minting directly (instead of calling `auth.api.requestPasswordReset`) is what
 * lets the invite pick its own expiry and email template without changing
 * forgot-password.
 *
 * Every earlier unused reset link for the user is deleted in the same
 * transaction that writes the new one, under a per-user advisory lock, so a
 * re-sent invite invalidates the one before it and two concurrent resends can
 * never leave two working links: the second waits for the first to commit,
 * then deletes its row.
 *
 * The row is written directly in Better-Auth 1.7's format — what
 * `requestPasswordReset` stores through `internalAdapter.createVerificationValue`:
 * `identifier: "reset-password:<token>"`, `value: <userId>`, `expiresAt` — because
 * the internal adapter cannot join a Prisma transaction. That format holds only
 * while the identifier is stored in plain text and verification rows live in
 * Postgres (no `verification.storeIdentifier`, no `secondaryStorage`); both are
 * checked here so a config change fails loudly instead of minting dead links.
 *
 * Refuses (`SetPasswordLinkRefusedError`) for a user with any non-credential
 * account, and (`SetPasswordLinkNotPendingError`) once the account is verified:
 * see those errors.
 */
export async function createSetPasswordLink({
  userId,
  locale,
  now = new Date(),
}: {
  userId: string;
  locale: unknown;
  now?: Date;
}): Promise<{ url: string; token: string; expiresAt: Date }> {
  const authContext = await auth.$context;
  // Widened on purpose: today's config sets neither key, so the inferred
  // options type has no such properties; this keeps the runtime guard for the
  // day someone adds one.
  const options: Record<string, unknown> = { ...authContext.options };
  const verification = options.verification;
  const transformsIdentifier =
    typeof verification === "object" &&
    verification !== null &&
    "storeIdentifier" in verification &&
    verification.storeIdentifier !== undefined;
  if (transformsIdentifier || options.secondaryStorage !== undefined) {
    throw new Error(
      "createSetPasswordLink writes plain-identifier verification rows to Postgres; update it for the new Better-Auth verification storage config.",
    );
  }

  // 32 random bytes, URL-safe: the token rides in a URL path segment.
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + INVITE_LINK_TTL_SECONDS * 1000);
  await prisma.$transaction(async (tx) => {
    // Serializes link minting and finished resets per user until this transaction ends.
    await lockCredentialSetup(tx, userId);
    // Still a pending invite, read under the lock: verified, signed in, not created by
    // `users.invite` (markAdminInvited: an unverified public sign-up looks the same otherwise)
    // or gone refuses.
    const state = await readInviteState(tx, userId, now);
    if (state?.accounts.some((account) => account.providerId !== CREDENTIAL_PROVIDER_ID)) {
      throw new SetPasswordLinkRefusedError();
    }
    if (!state || !isInvitePending(state)) throw new SetPasswordLinkNotPendingError();
    await tx.verification.deleteMany({
      where: { value: userId, identifier: { startsWith: RESET_PASSWORD_IDENTIFIER_PREFIX } },
    });
    await tx.verification.create({
      data: {
        identifier: `${RESET_PASSWORD_IDENTIFIER_PREFIX}${token}`,
        value: userId,
        expiresAt,
      },
      select: { id: true },
    });
  });

  const callbackURL = inviteCallbackUrl(locale);
  const url = `${authContext.baseURL}/reset-password/${token}?callbackURL=${encodeURIComponent(callbackURL)}`;
  return { url, token, expiresAt };
}

/**
 * Marks an account `users.invite` just created as an admin invite (credential-setup-lock.ts
 * ADMIN_INVITED_PREFIX), once and for good, in its own transaction before the first link: a
 * failure minting or mailing that link leaves the mark, so "Resend invite" still works.
 */
export async function markAdminInvited(userId: string): Promise<void> {
  const identifier = `${ADMIN_INVITED_PREFIX}${userId}`;
  await prisma.$transaction(async (tx) => {
    await lockCredentialSetup(tx, userId);
    const marked = await tx.verification.findFirst({
      where: { identifier },
      select: { id: true },
    });
    if (marked) return;
    await tx.verification.create({
      data: { identifier, value: userId, expiresAt: ADMIN_INVITED_EXPIRES_AT },
      select: { id: true },
    });
  });
}

/**
 * Where Better-Auth redirects after validating the token: the web app's
 * reset-password page in the invitee's locale, flagged as an invite so it
 * shows "set your password" copy. Absolute against the web origin, so a
 * split-origin deploy (`CORS_ORIGIN` set) lands on the app, not the API host;
 * both origins are in `trustedOrigins`, which Better-Auth's origin check
 * enforces on this value.
 */
export function inviteCallbackUrl(locale: unknown): string {
  const tag = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE;
  const webOrigin = env.CORS_ORIGIN ?? env.BETTER_AUTH_URL;
  return new URL(`/${tag}/reset-password?invite=1`, webOrigin).toString();
}
