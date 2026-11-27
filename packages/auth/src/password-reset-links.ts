import { createHash } from "node:crypto";
import prisma, { type Prisma } from "@ws-model-proxy/db";
import {
  ADMIN_INVITED_PREFIX,
  lockCredentialSetup,
  RESET_PASSWORD_IDENTIFIER_PREFIX,
} from "./credential-setup-lock";
import { provedEmailKey } from "./proved-email";

/**
 * Password-reset links: forgot-password mails and admin-invite set-password links. Both are
 * Better Auth `reset-password:<token>` verification rows (value = user id), spent by Better
 * Auth's `POST /reset-password`.
 *
 * Spending one sets the password. With SMTP configured it verifies (and proves, `provedEmail`)
 * the address only when that very token was mailed to it: the mail is the proof. A link the admin
 * was shown instead (the invite mail could not be sent) proves nothing about the mailbox, so
 * spending it leaves the account unverified, and the person verifies through verify-email (a
 * sign-in mails them a link). Otherwise an admin, or anyone the link was passed to, could make an
 * address nobody controls "verified". (Without SMTP nothing is ever mailed or proved, and
 * spending an invite link only activates the account: password-reset.ts `onPasswordReset`.)
 *
 * The "mailed" fact is a verification row next to the token ({@link recordResetLinkMailed}): no
 * schema change, and it expires with the link.
 *
 * The same fact decides who may spend a link ({@link isResetLinkRedeemable}): a mailed link works
 * for any account, a link the admin was shown works only while the account is still a pending
 * invite ({@link isInvitePending}). So a shown link left over after the invitee activated the
 * account is dead at redemption, whether or not the activation's tidy-up deleted it.
 */

/** Better Auth's endpoint that spends a reset token (`POST /api/auth/reset-password`). */
const RESET_PASSWORD_PATH = "/reset-password";

/**
 * The "this token was mailed" row: identifier `reset-password-mailed:<sha256(token)>` (the token
 * itself is never stored a second time), value the user id and the address it went to (JSON),
 * `expiresAt` the link's own. Not a `reset-password:` prefix, so nothing that lists or deletes
 * reset tokens mistakes it for one.
 */
const MAILED_IDENTIFIER_PREFIX = "reset-password-mailed:";

function mailedIdentifier(token: string): string {
  return `${MAILED_IDENTIFIER_PREFIX}${createHash("sha256").update(token).digest("base64url")}`;
}

/** Better Auth's id for an email/password account (`Account.providerId`). */
export const CREDENTIAL_PROVIDER_ID = "credential";

/**
 * What decides whether a user is still an unfinished invite (with the admin-invited mark, read
 * apart: credential-setup-lock.ts ADMIN_INVITED_PREFIX). Bounded: two account rows tell "exactly
 * one" from "more", one live session tells "never signed in" from "signed in".
 */
export function inviteStateSelect(now: Date) {
  return {
    emailVerified: true,
    accounts: { select: { providerId: true }, take: 2 },
    sessions: { where: { expiresAt: { gt: now } }, select: { id: true }, take: 1 },
  } satisfies Prisma.UserSelect;
}

/**
 * Pending invite = an account `users.invite` created (`adminInvited`, the permanent admin-invited
 * mark) that nobody has started using: email not verified, exactly one Account row and it is the
 * email/password ("credential") one, and no live session.
 *
 * `emailVerified === false` alone is NOT enough. An account with another provider linked must
 * never get a set-password link (a second way in next to that identity), and the live-session
 * rule covers an account in use by any other route. And an unverified public sign-up looks the
 * same otherwise: only the mark makes an invite.
 *
 * An invitee who set a password through a link the admin passed on is still pending (unverified,
 * so never signed in while SMTP is on): a resend then mails a fresh link, and spending that one
 * verifies the address.
 */
export function isInvitePending(row: {
  adminInvited: boolean;
  emailVerified: boolean;
  accounts: { providerId: string }[];
  sessions: { id: string }[];
}): boolean {
  return (
    row.adminInvited &&
    !row.emailVerified &&
    row.accounts.length === 1 &&
    row.accounts[0]?.providerId === CREDENTIAL_PROVIDER_ID &&
    row.sessions.length === 0
  );
}

/** Whether `users.invite` created this user (credential-setup-lock.ts ADMIN_INVITED_PREFIX). */
async function isAdminInvited(
  db: Pick<Prisma.TransactionClient, "verification">,
  userId: string,
): Promise<boolean> {
  const marked = await db.verification.findFirst({
    where: { identifier: `${ADMIN_INVITED_PREFIX}${userId}` },
    select: { id: true },
  });
  return marked !== null;
}

/**
 * The invite state of `userId` read inside `tx` (call it under {@link lockCredentialSetup}), or
 * null when the user is gone.
 */
export async function readInviteState(
  tx: Prisma.TransactionClient,
  userId: string,
  now: Date,
): Promise<Parameters<typeof isInvitePending>[0] | null> {
  const state = await tx.user.findUnique({ where: { id: userId }, select: inviteStateSelect(now) });
  if (!state) return null;
  return { ...state, adminInvited: await isAdminInvited(tx, userId) };
}

/** Every reset link of the user, spent or not. Run under {@link lockCredentialSetup}. */
export function deleteResetLinks(
  db: Pick<Prisma.TransactionClient, "verification">,
  userId: string,
) {
  return db.verification.deleteMany({
    where: { value: userId, identifier: { startsWith: RESET_PASSWORD_IDENTIFIER_PREFIX } },
  });
}

/**
 * Records that the reset link `token` goes to `email` by mail and nowhere else. Returns false,
 * and records nothing, when the link is already gone (spent, replaced, expired): a late record
 * must never outlive its link. The check and the insert are one transaction under the user's
 * credential-setup lock, which every delete of the user's links (a resend, a finished reset, an
 * activation) also takes, so none of them can slip in between.
 */
export async function recordResetLinkMailed(input: {
  token: string;
  userId: string;
  email: string;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    await lockCredentialSetup(tx, input.userId);
    const link = await tx.verification.findFirst({
      where: {
        identifier: `${RESET_PASSWORD_IDENTIFIER_PREFIX}${input.token}`,
        value: input.userId,
        expiresAt: { gt: now },
      },
      select: { expiresAt: true },
    });
    if (!link) return false;
    await tx.verification.create({
      data: {
        identifier: mailedIdentifier(input.token),
        value: JSON.stringify({ userId: input.userId, email: input.email }),
        expiresAt: link.expiresAt,
      },
      select: { id: true },
    });
    return true;
  });
}

/**
 * Whether Better Auth may spend the reset link `token` (the `/reset-password` before-hook asks).
 * A mailed link always may: the mail went to the account's own address (forgot-password, a mailed
 * invite). A link the admin was shown may only while the user is still a pending invite
 * ({@link isInvitePending}); once the account is active (verified, signed in) it is refused and
 * deleted. An unknown or expired token is left to Better Auth, which refuses it itself.
 *
 * The invite state is read under the credential-setup lock, the lock minting and the activation
 * tidy-up take, so it sees their committed result. (A mailed link needs no lock: it is spendable
 * in every state. A record written while this waited is checked again under the lock.) Better
 * Auth spends the token after this returns, outside the lock: an activation committing in that
 * gap orders the reset just before the activation, a reset the link was allowed to make anyway
 * (and the reset ends every session).
 */
export async function isResetLinkRedeemable(token: string, now = new Date()): Promise<boolean> {
  const identifier = `${RESET_PASSWORD_IDENTIFIER_PREFIX}${token}`;
  return prisma.$transaction(async (tx) => {
    const link = await tx.verification.findFirst({
      where: { identifier, expiresAt: { gt: now } },
      select: { value: true },
    });
    if (!link) return true;
    const userId = link.value;
    const mailedFor = async () => {
      const mailed = await tx.verification.findFirst({
        where: { identifier: mailedIdentifier(token), expiresAt: { gt: now } },
        select: { value: true },
      });
      return mailed !== null && parseMailed(mailed.value)?.userId === userId;
    };
    if (await mailedFor()) return true;
    await lockCredentialSetup(tx, userId);
    // Again under the lock: a record whose writer held the lock while we waited has committed
    // now, and must not be refused as "shown".
    if (await mailedFor()) return true;
    const state = await readInviteState(tx, userId, now);
    if (state && isInvitePending(state)) return true;
    await tx.verification.deleteMany({ where: { identifier, value: userId } });
    return false;
  });
}

function parseMailed(value: string): { userId: string; email: string } | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { userId, email } = parsed as Record<string, unknown>;
    return typeof userId === "string" && typeof email === "string" ? { userId, email } : null;
  } catch {
    return null;
  }
}

/**
 * Runs after Better Auth spent the reset token `token` (a successful `POST /reset-password`). If
 * that token was mailed, in one transaction under the user's credential-setup lock: the "mailed"
 * row is consumed, the address is marked verified and proved (`provedEmail`, only while it is
 * still the address the link went to), and every other reset link of the user is deleted.
 * Returns the user whose address was verified (for share-invite acceptance), else null. A token
 * that was not mailed changes nothing here.
 */
export async function verifyEmailIfResetLinkWasMailed(
  token: string,
): Promise<{ id: string; email: string } | null> {
  const identifier = mailedIdentifier(token);
  return prisma.$transaction(async (tx) => {
    const mailed = await tx.verification.findFirst({
      where: { identifier },
      select: { value: true },
    });
    if (!mailed) return null;
    const target = parseMailed(mailed.value);
    if (!target) {
      await tx.verification.deleteMany({ where: { identifier } });
      return null;
    }
    await lockCredentialSetup(tx, target.userId);
    const consumed = await tx.verification.deleteMany({ where: { identifier } });
    if (consumed.count === 0) return null;
    const verified = await tx.user.updateMany({
      where: { id: target.userId, email: target.email },
      data: { emailVerified: true, provedEmail: provedEmailKey(target.email) },
    });
    await deleteResetLinks(tx, target.userId);
    return verified.count > 0 ? { id: target.userId, email: target.email } : null;
  });
}

/**
 * The reset token a `POST /reset-password` request carries, or null. Better Auth reads it from
 * the body or the query, so this does too.
 */
export function resetTokenOf(ctx: {
  path?: string;
  body?: unknown;
  query?: unknown;
}): string | null {
  if (ctx.path !== RESET_PASSWORD_PATH) return null;
  const token =
    (isRecord(ctx.body) ? ctx.body.token : undefined) ||
    (isRecord(ctx.query) ? ctx.query.token : undefined);
  return typeof token === "string" && token.length > 0 ? token : null;
}

/**
 * The reset token a finished Better Auth request spent, or null. Only a successful
 * `POST /reset-password` (its result is `{ status: true }`, an error is an `APIError`) qualifies.
 */
export function spentResetToken(ctx: {
  path?: string;
  body?: unknown;
  query?: unknown;
  returned?: unknown;
}): string | null {
  if (!isRecord(ctx.returned) || ctx.returned.status !== true) return null;
  return resetTokenOf(ctx);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
