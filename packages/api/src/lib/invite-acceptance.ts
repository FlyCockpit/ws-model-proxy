/**
 * When a pool invite becomes a share (contract review fix). Pure: sign-up and sign-in call it
 * with the account and, if the person came through the invite link, the link's invite.
 *
 * - Through the link (the token matched a pending, unexpired invite): accepted, whatever the
 *   e-mail on the account; the token is the proof.
 * - Without the link: only invites to the account's e-mail, and only when that e-mail is
 *   verified. With e-mail verification off (no SMTP), anyone could register the address, so
 *   only the link works (`invite_needs_link`).
 */

export type PendingInvite = {
  id: string;
  email: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
};

export type InviteAcceptance =
  | { accept: true; inviteIds: string[] }
  | { accept: false; reason: "invite_needs_link" | "none" };

function pending(invite: PendingInvite, now: Date): boolean {
  return invite.acceptedAt === null && invite.revokedAt === null && invite.expiresAt > now;
}

export function inviteAcceptance(input: {
  account: { email: string; emailVerified: boolean };
  /** The invite whose link the person used, if any. */
  linkInvite: PendingInvite | null;
  /** Pending invites to the account's e-mail (lower-cased, trimmed match). */
  emailInvites: readonly PendingInvite[];
  now: Date;
}): InviteAcceptance {
  if (input.linkInvite && pending(input.linkInvite, input.now))
    return { accept: true, inviteIds: [input.linkInvite.id] };
  const email = input.account.email.trim().toLowerCase();
  const matching = input.emailInvites.filter(
    (invite) => invite.email === email && pending(invite, input.now),
  );
  if (matching.length === 0) return { accept: false, reason: "none" };
  if (!input.account.emailVerified) return { accept: false, reason: "invite_needs_link" };
  return { accept: true, inviteIds: matching.map((invite) => invite.id) };
}
