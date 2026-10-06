/**
 * Share invite acceptance (contract fix e4dc646b): a pending invite becomes a share through
 * its link, or by e-mail match only for a proven address (`inviteAcceptance`).
 *
 * - `acceptShareInvitesForProvenEmail`: Better Auth calls it (via the registry in
 *   `@ws-model-proxy/auth/share-invite-acceptance`) on account creation and on the e-mail
 *   verification routes, with `emailVerified` true only when verification is on.
 * - `acceptShareInviteByLink`: the invite sign-up flow. TODO(server): the sign-up route carries
 *   `?invite=` through to this call and lets that sign-up through while open sign-up is off.
 *
 * Share and invite writes take the owner fences of both people before the first write.
 */
import { registerShareInviteAcceptor } from "@ws-model-proxy/auth/share-invite-acceptance";
import prisma, { type Prisma } from "@ws-model-proxy/db";
import { fenceOwners, runCapacityOrderedTransaction } from "@ws-model-proxy/db/capacity-lock-order";
import { type InviteAcceptance, inviteAcceptance } from "./invite-acceptance";
import { pendingInviteWhere, SHARE_INVITE_TOKEN_PATTERN, shareInviteDigest } from "./share-invites";

type Tx = Prisma.TransactionClient;

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

async function acceptOne(tx: Tx, invite: InviteRow, userId: string, now: Date): Promise<boolean> {
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
  // Guarded on still pending: a concurrent accept or revoke wins and this one rolls back.
  const updated = await tx.shareInvite.updateMany({
    where: { id: invite.id, ...pendingInviteWhere(now) },
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

/** The invite whose link the person signed up through becomes a share (the token is proof). */
export async function acceptShareInviteByLink(
  user: { id: string; email: string },
  token: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (!SHARE_INVITE_TOKEN_PATTERN.test(token)) return false;
  const linkInvite = await prisma.shareInvite.findFirst({
    where: { tokenDigest: shareInviteDigest(token), ...pendingInviteWhere(now) },
    select: inviteSelect,
  });
  if (!linkInvite) return false;
  const decision = inviteAcceptance({
    account: { email: user.email, emailVerified: false },
    linkInvite,
    emailInvites: [],
    now,
  });
  await applyAcceptance(user.id, [linkInvite], decision, now);
  return decision.accept;
}

registerShareInviteAcceptor((user) => acceptShareInvitesForProvenEmail(user));
