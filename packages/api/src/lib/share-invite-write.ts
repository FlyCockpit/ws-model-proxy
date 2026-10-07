/**
 * Writing and delivering share invites, for both targets: a pool (`access.shares.create`) and a
 * runtime definition (`runtimes.shares.create`); resend for either (`access.invites.resend`).
 *
 * Both share procedures give the share directly only to an account whose mailbox the
 * verify-email flow proved (`hasProvedEmail`); anyone else, an unknown e-mail included, gets an
 * invite with the same answer shape, so the answer does not tell whether an account exists.
 *
 * Writes run under the owner's fence (`runAccessTransaction`): share_invite is a graph table.
 */
import { ORPCError } from "@orpc/server";
import prisma from "@ws-model-proxy/db";
import { runAccessTransaction } from "./access-transaction";
import { shareInviteSelect, shareInviteTarget, shareInviteView } from "./access-views";
import { isUniqueViolation, notFound } from "./refuse";
import {
  generateShareInviteToken,
  pendingInviteWhere,
  SHARE_INVITE_MAX_PENDING_PER_OWNER,
  SHARE_INVITE_RESEND_COOLDOWN_MS,
  SHARE_INVITE_TTL_MS,
  sendShareInviteEmail,
  shareInviteDigest,
  shareInviteUrl,
} from "./share-invites";

const NOT_FOUND = "That key, token, connection, share or invite does not exist.";

export type InviteSettings = {
  canUse: boolean;
  canContribute: boolean;
  priorityClass: "BACKGROUND" | "NORMAL" | "HIGH" | null;
};

/** What a new invite shares. A runtime invite carries no settings (can use only). */
export type InviteTarget =
  | { kind: "pool"; poolId: string; settings: InviteSettings }
  | { kind: "runtime"; runtimeId: string };

function pendingConflict(target: InviteTarget["kind"]): ORPCError<"CONFLICT", unknown> {
  return new ORPCError("CONFLICT", {
    message:
      target === "pool"
        ? "This e-mail already has a pending invite to this pool. Resend it instead."
        : "This e-mail already has a pending invite to this runtime. Resend it instead.",
  });
}

/**
 * Writes a pending invite for (target, e-mail) with a fresh token (contract fix): a new invite
 * when none is pending, or, for a resend, the pending one with its token and expiry rotated
 * (the old link stops working). Earlier accepted, revoked or expired rows stay as history.
 */
export async function writeInvite(
  args:
    | { mode: "create"; ownerUserId: string; target: InviteTarget; email: string }
    | { mode: "resend"; ownerUserId: string; inviteId: string },
) {
  const now = new Date();
  const token = generateShareInviteToken();
  const tokenDigest = shareInviteDigest(token);
  const expiresAt = new Date(now.getTime() + SHARE_INVITE_TTL_MS);
  const row = await runAccessTransaction({ owners: [args.ownerUserId] }, async (tx) => {
    if (args.mode === "resend") {
      const invite = await tx.shareInvite.findFirst({
        where: { id: args.inviteId, ownerUserId: args.ownerUserId, ...pendingInviteWhere(now) },
        select: { createdAt: true, updatedAt: true },
      });
      if (!invite) throw notFound(NOT_FOUND);
      if (now.getTime() - invite.updatedAt.getTime() < SHARE_INVITE_RESEND_COOLDOWN_MS) {
        throw new ORPCError("CONFLICT", {
          message: "This invite was just sent. Wait a minute before sending it again.",
          data: { reason: "rate_limited" },
        });
      }
      const rotated = await tx.shareInvite.updateMany({
        where: { id: args.inviteId, ownerUserId: args.ownerUserId, ...pendingInviteWhere(now) },
        // A new link starts free: an old link's sign-up claim does not hold the new one.
        data: {
          tokenDigest,
          expiresAt,
          emailSentAt: null,
          signupClaimedAt: null,
          signupClaimedEmail: null,
        },
      });
      if (rotated.count !== 1) throw notFound(NOT_FOUND);
      return tx.shareInvite.findUniqueOrThrow({
        where: { id: args.inviteId },
        select: shareInviteSelect,
      });
    }
    const { target } = args;
    const targetWhere =
      target.kind === "pool" ? { poolId: target.poolId } : { runtimeId: target.runtimeId };
    // An expired invite still holds the one-pending slot (the partial unique index ignores
    // expiry): withdraw it so the address can be invited again.
    await tx.shareInvite.updateMany({
      where: {
        ...targetWhere,
        email: args.email,
        ownerUserId: args.ownerUserId,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { lte: now },
      },
      data: { revokedAt: now },
    });
    const pending = await tx.shareInvite.findFirst({
      where: { ...targetWhere, email: args.email, ...pendingInviteWhere(now) },
      select: { id: true },
    });
    if (pending) throw pendingConflict(target.kind);
    const pendingCount = await tx.shareInvite.count({
      where: { ownerUserId: args.ownerUserId, ...pendingInviteWhere(now) },
    });
    if (pendingCount >= SHARE_INVITE_MAX_PENDING_PER_OWNER) {
      throw new ORPCError("CONFLICT", {
        message: "Too many pending invites. Withdraw some before inviting more people.",
      });
    }
    return tx.shareInvite
      .create({
        data: {
          ...targetWhere,
          ownerUserId: args.ownerUserId,
          email: args.email,
          tokenDigest,
          ...(target.kind === "pool"
            ? {
                canUse: target.settings.canUse,
                canContribute: target.settings.canContribute,
                priorityClass: target.settings.priorityClass,
              }
            : { canUse: true, canContribute: false, priorityClass: null }),
          expiresAt,
        },
        select: shareInviteSelect,
      })
      .catch((error: unknown) => {
        // One pending invite per target and e-mail (partial unique indexes): a concurrent
        // invite to the same address won.
        if (isUniqueViolation(error)) throw pendingConflict(target.kind);
        throw error;
      });
  });
  return { row, token, expiresAt: row.expiresAt };
}

/** E-mails the invite; returns the view and, only when no e-mail went out, the link. */
export async function deliverInvite(args: {
  row: Awaited<ReturnType<typeof writeInvite>>["row"];
  token: string;
  expiresAt: Date;
  owner: { name: string; locale: string };
}) {
  const target = shareInviteTarget(args.row);
  const sent = await sendShareInviteEmail({
    to: args.row.email,
    ownerName: args.owner.name,
    target:
      target.kind === "pool"
        ? { kind: "pool", callableId: target.callableId }
        : { kind: "runtime", name: target.name },
    token: args.token,
    expiresAt: args.expiresAt,
    locale: args.owner.locale,
  });
  if (!sent) {
    return {
      invite: shareInviteView(args.row),
      link: shareInviteUrl(args.token, args.owner.locale),
    };
  }
  // emailSentAt is a status column: no fence.
  const updated = await prisma.shareInvite.update({
    where: { id: args.row.id },
    data: { emailSentAt: new Date() },
    select: shareInviteSelect,
  });
  return { invite: shareInviteView(updated), link: null };
}
