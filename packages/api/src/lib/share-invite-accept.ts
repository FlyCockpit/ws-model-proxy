/**
 * Share invite acceptance (contract fix e4dc646b): a pending invite becomes a share through
 * its link, or by e-mail match only for a proven address (`inviteAcceptance`).
 *
 * - `acceptShareInvitesForProvenEmail`: Better Auth calls it (via the registry in
 *   `@ws-model-proxy/auth/share-invite-acceptance`) on account creation and on the e-mail
 *   verification routes, with `emailVerified` true only when verification is on.
 * - Invite-link sign-up: the sign-up page sends the `?invite=` token in the `x-wsmp-invite`
 *   header. The server's sign-up gate checks `isPendingShareInvite`; the user-create `before`
 *   hook reserves the invite (`claimShareInviteForSignup`, one sign-up per token) and the create
 *   `after` hook accepts the reserved invite (`acceptClaimedShareInvite`), both via the registry.
 * - `acceptShareInviteByLink`: a signed-in person opening an invite link (`auth.acceptInvite`).
 *
 * Share and invite writes take the owner fences of both people before the first write.
 */
import {
  registerShareInviteAcceptor,
  registerShareInviteLinkAcceptor,
} from "@ws-model-proxy/auth/share-invite-acceptance";
import prisma, { type Prisma } from "@ws-model-proxy/db";
import { fenceOwners, runCapacityOrderedTransaction } from "@ws-model-proxy/db/capacity-lock-order";
import { type InviteAcceptance, inviteAcceptance } from "./invite-acceptance";
import {
  pendingInviteWhere,
  SHARE_INVITE_TOKEN_PATTERN,
  shareInviteDigest,
  unclaimedInviteWhere,
} from "./share-invites";

type Tx = Prisma.TransactionClient;
type InviteWhere = Prisma.ShareInviteWhereInput;

const inviteSelect = {
  id: true,
  email: true,
  expiresAt: true,
  acceptedAt: true,
  revokedAt: true,
  poolId: true,
  ownerUserId: true,
  canUse: true,
  canContribute: true,
  priorityClass: true,
} as const;
type InviteRow = Prisma.ShareInviteGetPayload<{ select: typeof inviteSelect }>;

/** What became of an invite link: accepted (now or already a share), or not. */
export type LinkAcceptance = "accepted" | "invalid" | "own_pool";

/** Pending, plus whatever extra condition the caller holds the invite under. */
function liveInviteWhere(now: Date, guard: InviteWhere): InviteWhere {
  return { AND: [pendingInviteWhere(now), guard] };
}

async function acceptOne(
  tx: Tx,
  invite: InviteRow,
  userId: string,
  now: Date,
  guard: InviteWhere = {},
): Promise<boolean> {
  if (invite.ownerUserId === userId) return false;
  const existing = await tx.share.findUnique({
    where: { poolId_granteeUserId: { poolId: invite.poolId, granteeUserId: userId } },
    select: { id: true },
  });
  const shareId =
    existing?.id ??
    (
      await tx.share.create({
        data: {
          poolId: invite.poolId,
          ownerUserId: invite.ownerUserId,
          granteeUserId: userId,
          canUse: invite.canUse,
          canContribute: invite.canContribute,
          priorityClass: invite.priorityClass,
        },
        select: { id: true },
      })
    ).id;
  // Guarded on still pending (and the caller's hold): a concurrent accept or revoke wins and
  // this one rolls back.
  const updated = await tx.shareInvite.updateMany({
    where: { id: invite.id, ...liveInviteWhere(now, guard) },
    data: { acceptedAt: now, shareId },
  });
  if (updated.count !== 1) throw new Error("share invite changed concurrently");
  return !existing;
}

/** Applies a decision under the fences of the account and every inviting owner. */
async function applyAcceptance(
  userId: string,
  candidates: readonly InviteRow[],
  decision: InviteAcceptance,
  now: Date,
): Promise<number> {
  if (!decision.accept) return 0;
  const chosen = candidates.filter((invite) => decision.inviteIds.includes(invite.id));
  if (chosen.length === 0) return 0;
  const ownerIds = [...new Set(chosen.map((invite) => invite.ownerUserId))];
  return runCapacityOrderedTransaction(prisma, async (tx) => {
    await fenceOwners(tx, [userId, ...ownerIds]);
    // Re-read under the fences: only invites still pending are accepted.
    const current = await tx.shareInvite.findMany({
      where: { id: { in: chosen.map((invite) => invite.id) }, ...pendingInviteWhere(now) },
      select: inviteSelect,
    });
    let created = 0;
    for (const invite of current) if (await acceptOne(tx, invite, userId, now)) created += 1;
    return created;
  });
}

/** Pending invites to a proven e-mail become shares. Returns the shares created. */
export async function acceptShareInvitesForProvenEmail(
  user: { id: string; email: string; emailVerified: boolean },
  now: Date = new Date(),
): Promise<number> {
  const email = user.email.trim().toLowerCase();
  const emailInvites = await prisma.shareInvite.findMany({
    where: { email, ...pendingInviteWhere(now) },
    select: inviteSelect,
    take: 200,
  });
  const decision = inviteAcceptance({
    account: { email, emailVerified: user.emailVerified },
    linkInvite: null,
    emailInvites,
    now,
  });
  return applyAcceptance(user.id, emailInvites, decision, now);
}

/** The link's invite becomes a share for the user, whatever its e-mail (the token is proof). */
async function acceptLink(
  user: { id: string; email: string },
  token: string,
  guard: InviteWhere,
  now: Date,
): Promise<LinkAcceptance> {
  if (!SHARE_INVITE_TOKEN_PATTERN.test(token)) return "invalid";
  const linkInvite = await prisma.shareInvite.findFirst({
    where: { tokenDigest: shareInviteDigest(token), ...liveInviteWhere(now, guard) },
    select: inviteSelect,
  });
  if (!linkInvite) return "invalid";
  if (linkInvite.ownerUserId === user.id) return "own_pool";
  const decision = inviteAcceptance({
    account: { email: user.email, emailVerified: false },
    linkInvite,
    emailInvites: [],
    now,
  });
  if (!decision.accept) return "invalid";
  return runCapacityOrderedTransaction(prisma, async (tx) => {
    await fenceOwners(tx, [user.id, linkInvite.ownerUserId]);
    // Re-read under the fences: a revoke, expiry or other acceptance since wins.
    const current = await tx.shareInvite.findFirst({
      where: { id: linkInvite.id, ...liveInviteWhere(now, guard) },
      select: inviteSelect,
    });
    if (!current) return "invalid";
    await acceptOne(tx, current, user.id, now, guard);
    return "accepted";
  });
}

/**
 * A signed-in person accepts an invite link. An invite a sign-up has reserved (within the claim
 * window) is left to that sign-up.
 */
export async function acceptShareInviteByLink(
  user: { id: string; email: string },
  token: string,
  now: Date = new Date(),
): Promise<LinkAcceptance> {
  return acceptLink(user, token, unclaimedInviteWhere(now), now);
}

/** The invite this sign-up reserved (`claimedAt`) becomes the new account's share. */
export async function acceptClaimedShareInvite(
  user: { id: string; email: string },
  token: string,
  claimedAt: Date,
  now: Date = new Date(),
): Promise<boolean> {
  return (await acceptLink(user, token, { signupClaimedAt: claimedAt }, now)) === "accepted";
}

/** Whether the token belongs to a pending, unexpired invite (looked up by its digest). */
export async function isPendingShareInvite(
  token: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (!SHARE_INVITE_TOKEN_PATTERN.test(token)) return false;
  const invite = await prisma.shareInvite.findFirst({
    where: { tokenDigest: shareInviteDigest(token), ...pendingInviteWhere(now) },
    select: { id: true },
  });
  return invite !== null;
}

/**
 * Reserves the token's pending invite for one sign-up: an atomic guarded update, so of two
 * sign-ups with one token at once only one gets the claim. Returns the claim's time (the
 * after hook accepts the invite under it), or null when the invite is not pending or another
 * sign-up holds it.
 */
export async function claimShareInviteForSignup(
  token: string,
  now: Date = new Date(),
): Promise<Date | null> {
  if (!SHARE_INVITE_TOKEN_PATTERN.test(token)) return null;
  const claimed = await prisma.shareInvite.updateMany({
    where: {
      tokenDigest: shareInviteDigest(token),
      ...liveInviteWhere(now, unclaimedInviteWhere(now)),
    },
    data: { signupClaimedAt: now },
  });
  return claimed.count === 1 ? now : null;
}

registerShareInviteAcceptor((user) => acceptShareInvitesForProvenEmail(user));
registerShareInviteLinkAcceptor({
  isPending: (token) => isPendingShareInvite(token),
  claim: (token) => claimShareInviteForSignup(token),
  accept: (user, token, claimedAt) => acceptClaimedShareInvite(user, token, claimedAt),
});
