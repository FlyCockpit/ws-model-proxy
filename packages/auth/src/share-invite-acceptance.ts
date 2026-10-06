/**
 * Share invite acceptance (owner decision round 3, contract fix): a pending invite becomes a
 * share for the person who proves the invited e-mail.
 *
 * - By e-mail match only when the e-mail is really verified: SMTP is configured (so
 *   `emailVerified` came from the verify-email flow) and the account's e-mail is verified.
 *   Without SMTP every account is created with `emailVerified: true` unproven, so a match is
 *   not enough there.
 * - Otherwise only with the invite token (`acceptShareInviteByToken`), which the invite
 *   sign-up flow presents. TODO(server): the sign-up route carries `?invite=` through to
 *   this call and lets that sign-up through while open sign-up is off.
 */
import prisma, { type Prisma } from "@ws-model-proxy/db";
import { fenceOwners, runCapacityOrderedTransaction } from "@ws-model-proxy/db/capacity-lock-order";
import { credentialDigest } from "@ws-model-proxy/db/node-security";

type Tx = Prisma.TransactionClient;
type InviteRow = {
  id: string;
  poolId: string;
  ownerUserId: string;
  canUse: boolean;
  canContribute: boolean;
  priorityClass: "BACKGROUND" | "NORMAL" | "HIGH" | null;
};

const inviteSelect = {
  id: true,
  poolId: true,
  ownerUserId: true,
  canUse: true,
  canContribute: true,
  priorityClass: true,
} as const;

function pendingWhere(now: Date) {
  return { acceptedAt: null, revokedAt: null, expiresAt: { gt: now } };
}

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
    where: { id: invite.id, ...pendingWhere(now) },
    data: { acceptedAt: now, shareId },
  });
  if (updated.count !== 1) throw new Error("share invite changed concurrently");
  return !existing;
}

/** Accepts every pending invite to this verified e-mail. Returns the shares created. */
export async function acceptShareInvitesForVerifiedEmail(
  user: { id: string; email: string; emailVerified: boolean },
  options: { emailConfigured: boolean; now?: Date },
): Promise<number> {
  if (!options.emailConfigured || !user.emailVerified) return 0;
  const now = options.now ?? new Date();
  const email = user.email.trim().toLowerCase();
  const where = { email, ...pendingWhere(now) };
  const owners = await prisma.shareInvite.findMany({
    where,
    select: { ownerUserId: true },
    distinct: ["ownerUserId"],
  });
  if (owners.length === 0) return 0;
  const ownerIds = owners.map((row) => row.ownerUserId);
  // Share and invite writes need the owner fences of both people, before the first write.
  return runCapacityOrderedTransaction(prisma, async (tx) => {
    await fenceOwners(tx, [user.id, ...ownerIds]);
    // Invites from owners not fenced here (sent meanwhile) wait for the next proof.
    const invites = await tx.shareInvite.findMany({
      where: { ...where, ownerUserId: { in: ownerIds } },
      select: inviteSelect,
    });
    let created = 0;
    for (const invite of invites) if (await acceptOne(tx, invite, user.id, now)) created += 1;
    return created;
  });
}

/**
 * Accepts the one pending invite this token names, for the person signing up with it. The
 * account's e-mail must be the invited one.
 */
export async function acceptShareInviteByToken(
  user: { id: string; email: string },
  token: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (!/^wsmp_inv_[A-Z2-7]{26}$/.test(token)) return false;
  const email = user.email.trim().toLowerCase();
  const where = {
    tokenDigest: credentialDigest("shareInvite", token),
    email,
    ...pendingWhere(now),
  };
  const found = await prisma.shareInvite.findFirst({ where, select: { ownerUserId: true } });
  if (!found) return false;
  return runCapacityOrderedTransaction(prisma, async (tx) => {
    await fenceOwners(tx, [user.id, found.ownerUserId]);
    const invite = await tx.shareInvite.findFirst({ where, select: inviteSelect });
    if (!invite) return false;
    await acceptOne(tx, invite, user.id, now);
    return true;
  });
}

/** Better Auth routes that prove an e-mail (link verification and the e-mail OTP flow). */
export function isEmailVerificationPath(path: unknown): boolean {
  return path === "/verify-email" || path === "/email-otp/verify-email";
}
