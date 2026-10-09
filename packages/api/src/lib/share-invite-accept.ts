/**
 * Share invite acceptance (contract fix e4dc646b): a pending invite becomes a share (of its pool,
 * or of its runtime definition) through its link, or by e-mail match only for a proven address
 * (`inviteAcceptance`).
 *
 * - `acceptShareInvitesForProvenEmail`: Better Auth calls it (via the registry in
 *   `@ws-model-proxy/auth/share-invite-acceptance`) on account creation and on the e-mail
 *   verification routes, with `emailVerified` true only when verification is on.
 * - Invite-link sign-up: the sign-up page sends the `?invite=` token in the `x-wsmp-invite`
 *   header. The server's sign-up gate checks `isPendingShareInvite`; the user-create `before`
 *   hook reserves the invite for the sign-up's e-mail (`claimShareInviteForSignup`, one e-mail
 *   per token) and the create `after` hook accepts it (`acceptClaimedShareInvite`), both via the
 *   registry.
 * - `acceptShareInviteByLink`: a signed-in person opening an invite link (`auth.acceptInvite`).
 *
 * Share and invite writes take the owner fences of both people before the first write.
 */
import {
  registerShareInviteAcceptor,
  registerShareInviteLinkAcceptor,
  type ShareInviteClaimResult,
} from "@ws-model-proxy/auth/share-invite-acceptance";
import prisma, { type Prisma } from "@ws-model-proxy/db";
import { fenceOwners, runCapacityOrderedTransaction } from "@ws-model-proxy/db/capacity-lock-order";
import { callableIdOf } from "./access-views";
import { type InviteAcceptance, inviteAcceptance, inviteEmailKey } from "./invite-acceptance";
import { modelNameClashes } from "./model-names";
import {
  claimUnchangedWhere,
  pendingInviteWhere,
  SHARE_INVITE_SIGNUP_CLAIM_MS,
  SHARE_INVITE_TOKEN_PATTERN,
  type SignupClaim,
  shareInviteDigest,
} from "./share-invites";

/** The guarded acceptance write lost to a concurrent accept, revoke or claim (rolled back). */
class InviteChangedError extends Error {
  constructor() {
    super("share invite changed concurrently");
    this.name = "InviteChangedError";
  }
}

type Tx = Prisma.TransactionClient;
type InviteWhere = Prisma.ShareInviteWhereInput;

const inviteSelect = {
  id: true,
  email: true,
  expiresAt: true,
  acceptedAt: true,
  revokedAt: true,
  poolId: true,
  runtimeId: true,
  ownerUserId: true,
  canUse: true,
  canContribute: true,
  priorityClass: true,
} as const;
type InviteRow = Prisma.ShareInviteGetPayload<{ select: typeof inviteSelect }>;

/**
 * What became of an invite link: accepted (now or already a share), or not (`own`: the invite
 * is to the person's own pool or runtime; `name_taken`: one of the person's model-name aliases
 * has the pool's callable ID, and the invite stays pending until they remove it).
 */
export type LinkAcceptance = "accepted" | "invalid" | "own" | "in_use" | "name_taken";

/** Pending, plus whatever extra condition the caller holds the invite under. */
function liveInviteWhere(now: Date, guard: InviteWhere): InviteWhere {
  return { AND: [pendingInviteWhere(now), guard] };
}

/**
 * What a link holds the invite under: still the presented token (a resend rotates it, and the
 * old link must stop working at once) and the sign-up claim as read.
 */
function linkHoldWhere(tokenDigest: string, claim: SignupClaim): InviteWhere {
  return { tokenDigest, ...claimUnchangedWhere(claim) };
}

/**
 * The pool share, or runtime share, the invite becomes; `created` when it did not exist. Null
 * when a new can-use pool share would give the person a callable ID one of their aliases already
 * has (lib/model-names.ts; the caller holds their owner fence): nothing is written.
 */
async function shareFor(
  tx: Tx,
  invite: InviteRow,
  userId: string,
): Promise<{ data: { shareId: string } | { runtimeShareId: string }; created: boolean } | null> {
  if (invite.runtimeId !== null) {
    const where = {
      runtimeId_granteeUserId: { runtimeId: invite.runtimeId, granteeUserId: userId },
    };
    const existing = await tx.runtimeShare.findUnique({ where, select: { id: true } });
    if (existing) return { data: { runtimeShareId: existing.id }, created: false };
    const created = await tx.runtimeShare.create({
      data: { runtimeId: invite.runtimeId, ownerUserId: invite.ownerUserId, granteeUserId: userId },
      select: { id: true },
    });
    return { data: { runtimeShareId: created.id }, created: true };
  }
  // The hardening keeps exactly one target.
  if (invite.poolId === null) throw new Error("share invite without a target");
  const existing = await tx.share.findUnique({
    where: { poolId_granteeUserId: { poolId: invite.poolId, granteeUserId: userId } },
    select: { id: true },
  });
  if (existing) return { data: { shareId: existing.id }, created: false };
  if (invite.canUse) {
    const pool = await tx.pool.findUnique({
      where: { id: invite.poolId },
      select: { slug: true, User: { select: { slug: true } } },
    });
    const clashes = pool
      ? await modelNameClashes(tx, [
          { userId, callableIds: [callableIdOf(pool.User.slug, pool.slug)] },
        ])
      : [];
    if (clashes.length > 0) return null;
  }
  const created = await tx.share.create({
    data: {
      poolId: invite.poolId,
      ownerUserId: invite.ownerUserId,
      granteeUserId: userId,
      canUse: invite.canUse,
      canContribute: invite.canContribute,
      priorityClass: invite.priorityClass,
    },
    select: { id: true },
  });
  return { data: { shareId: created.id }, created: true };
}

/**
 * `created` / `existing`: the invite is accepted as a new or an existing share. `name_taken`:
 * left pending, since the share would clash with one of the person's aliases.
 */
type AcceptOutcome = "created" | "existing" | "own" | "name_taken";

async function acceptOne(
  tx: Tx,
  invite: InviteRow,
  userId: string,
  now: Date,
  guard: InviteWhere = {},
): Promise<AcceptOutcome> {
  if (invite.ownerUserId === userId) return "own";
  const share = await shareFor(tx, invite, userId);
  if (!share) return "name_taken";
  // Guarded on still pending (and the caller's hold): a concurrent accept or revoke wins and
  // this one rolls back.
  const updated = await tx.shareInvite.updateMany({
    where: { id: invite.id, ...liveInviteWhere(now, guard) },
    data: { acceptedAt: now, ...share.data },
  });
  if (updated.count !== 1) throw new InviteChangedError();
  return share.created ? "created" : "existing";
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
    // An invite whose share would clash with one of the person's aliases stays pending: they
    // accept it through its link once the alias is gone, and the link page says why.
    for (const invite of current)
      if ((await acceptOne(tx, invite, userId, now)) === "created") created += 1;
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

/**
 * Who may take an invite against its sign-up claim, for an account or sign-up with `email`:
 * - `free`: never claimed, or the claim is stale and no account has the claimant e-mail;
 * - `mine`: claimed by this e-mail (e-mails are unique: the same person, so it may take over
 *   a fresh claim, e.g. after its sign-up rolled back);
 * - `in_use`: another e-mail's sign-up claimed it within the claim window;
 * - `taken`: a stale claim whose claimant now has an account (the invite stays with it; that
 *   account accepts it signed in).
 */
type ClaimHold = "free" | "mine" | "in_use" | "taken";

async function claimHold(claim: SignupClaim, email: string, now: Date): Promise<ClaimHold> {
  if (claim.signupClaimedAt === null || claim.signupClaimedEmail === null) return "free";
  if (claim.signupClaimedEmail === email) return "mine";
  if (claim.signupClaimedAt.getTime() > now.getTime() - SHARE_INVITE_SIGNUP_CLAIM_MS)
    return "in_use";
  const claimant = await prisma.user.findUnique({
    where: { email: claim.signupClaimedEmail },
    select: { id: true },
  });
  return claimant ? "taken" : "free";
}

const claimSelect = { signupClaimedAt: true, signupClaimedEmail: true } as const;

/**
 * The link's invite becomes a share for the user, whatever its e-mail (the token is proof).
 * `signup`: only the sign-up that holds the claim (same e-mail); `signed_in`: anyone the claim
 * does not keep out. Every write is guarded on the claim being unchanged since it was read.
 */
async function acceptLink(
  user: { id: string; email: string },
  token: string,
  mode: "signup" | "signed_in",
  now: Date,
): Promise<LinkAcceptance> {
  if (!SHARE_INVITE_TOKEN_PATTERN.test(token)) return "invalid";
  const tokenDigest = shareInviteDigest(token);
  const linkInvite = await prisma.shareInvite.findFirst({
    where: { tokenDigest, ...pendingInviteWhere(now) },
    select: { ...inviteSelect, ...claimSelect },
  });
  if (!linkInvite) return "invalid";
  if (linkInvite.ownerUserId === user.id) return "own";
  const hold = await claimHold(linkInvite, inviteEmailKey(user.email), now);
  if (mode === "signup" && hold !== "mine") return "invalid";
  if (hold === "in_use") return "in_use";
  if (hold === "taken") return "invalid";
  const decision = inviteAcceptance({
    account: { email: user.email, emailVerified: false },
    linkInvite,
    emailInvites: [],
    now,
  });
  if (!decision.accept) return "invalid";
  const guard = linkHoldWhere(tokenDigest, linkInvite);
  try {
    return await runCapacityOrderedTransaction(prisma, async (tx) => {
      await fenceOwners(tx, [user.id, linkInvite.ownerUserId]);
      // Re-read under the fences: a revoke, expiry, resend (new token), other acceptance or new
      // claim since wins.
      const current = await tx.shareInvite.findFirst({
        where: { id: linkInvite.id, ...liveInviteWhere(now, guard) },
        select: inviteSelect,
      });
      if (!current) return "invalid";
      const outcome = await acceptOne(tx, current, user.id, now, guard);
      return outcome === "name_taken" ? "name_taken" : "accepted";
    });
  } catch (error) {
    // Lost the guarded write to a concurrent change: the transaction rolled back.
    if (error instanceof InviteChangedError) return "invalid";
    throw error;
  }
}

/**
 * A signed-in person accepts an invite link. A fresh claim by another e-mail's sign-up is left
 * to it (`in_use`); a claim of this person's own e-mail (a sign-up whose acceptance failed) is
 * theirs to finish.
 */
export async function acceptShareInviteByLink(
  user: { id: string; email: string },
  token: string,
  now: Date = new Date(),
): Promise<LinkAcceptance> {
  return acceptLink(user, token, "signed_in", now);
}

/** The invite this new account's sign-up claimed (same e-mail) becomes its share. */
export async function acceptClaimedShareInvite(
  user: { id: string; email: string },
  token: string,
  now: Date = new Date(),
): Promise<boolean> {
  return (await acceptLink(user, token, "signup", now)) === "accepted";
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
 * Reserves the token's pending invite for one sign-up with `email`. The claim is a
 * compare-and-swap on the claim as read, so of two sign-ups with one token at once only one
 * wins. It runs outside Better Auth's sign-up transaction, so it survives a rolled-back
 * sign-up; the same e-mail may then take it over at once.
 */
export async function claimShareInviteForSignup(
  token: string,
  email: string,
  now: Date = new Date(),
): Promise<ShareInviteClaimResult> {
  if (!SHARE_INVITE_TOKEN_PATTERN.test(token)) return "invalid";
  const claimant = inviteEmailKey(email);
  const tokenDigest = shareInviteDigest(token);
  const invite = await prisma.shareInvite.findFirst({
    where: { tokenDigest, ...pendingInviteWhere(now) },
    select: { id: true, ...claimSelect },
  });
  if (!invite) return "invalid";
  const hold = await claimHold(invite, claimant, now);
  if (hold === "in_use") return "in_use";
  if (hold === "taken") return "invalid";
  const claimed = await prisma.shareInvite.updateMany({
    where: { id: invite.id, ...liveInviteWhere(now, linkHoldWhere(tokenDigest, invite)) },
    data: { signupClaimedAt: now, signupClaimedEmail: claimant },
  });
  if (claimed.count === 1) return "claimed";
  // Lost the swap: to another claim (in use), or the invite was accepted, revoked, expired or
  // resent (this token no longer opens it).
  const still = await prisma.shareInvite.findFirst({
    where: { id: invite.id, tokenDigest, ...pendingInviteWhere(now) },
    select: { id: true },
  });
  return still ? "in_use" : "invalid";
}

registerShareInviteAcceptor((user) => acceptShareInvitesForProvenEmail(user));
registerShareInviteLinkAcceptor({
  isPending: (token) => isPendingShareInvite(token),
  claim: (token, email) => claimShareInviteForSignup(token, email),
  accept: (user, token) => acceptClaimedShareInvite(user, token),
});
