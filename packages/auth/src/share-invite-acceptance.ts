/**
 * Where Better Auth hands a proven e-mail or an invite link token to share-invite acceptance.
 * The acceptance itself (database writes, the `inviteAcceptance` rule) lives in
 * `@ws-model-proxy/api` (`lib/share-invite-accept.ts`), which registers itself here when the API
 * router loads; this package cannot depend on the API package. Until then nothing is accepted
 * and no token counts as pending (fail closed).
 */
export type ShareInviteAcceptor = (user: {
  id: string;
  email: string;
  /** True only when the address is proven (verified with e-mail verification on). */
  emailVerified: boolean;
}) => Promise<number>;

/** The invite sign-up flow: the token is the proof, whatever e-mail the account uses. */
export type ShareInviteLinkAcceptor = {
  /** Whether the token belongs to a pending, unexpired invite (reserves nothing). */
  isPending: (token: string) => Promise<boolean>;
  /**
   * Reserves the token's pending invite for one sign-up (atomic): the claim's time, or null
   * when the invite is not pending or another sign-up holds it.
   */
  claim: (token: string) => Promise<Date | null>;
  /** Turns the invite reserved at `claimedAt` into the user's share; false when it could not. */
  accept: (user: { id: string; email: string }, token: string, claimedAt: Date) => Promise<boolean>;
};

let acceptor: ShareInviteAcceptor | null = null;
let linkAcceptor: ShareInviteLinkAcceptor | null = null;

export function registerShareInviteAcceptor(next: ShareInviteAcceptor): void {
  acceptor = next;
}

export function registerShareInviteLinkAcceptor(next: ShareInviteLinkAcceptor): void {
  linkAcceptor = next;
}

/** Accepts the pending invites to a proven e-mail; 0 when no acceptor is registered. */
export async function acceptShareInvitesForProvenEmail(
  user: Parameters<ShareInviteAcceptor>[0],
): Promise<number> {
  return acceptor ? acceptor(user) : 0;
}

/** Whether an invite link token is pending; false when no link acceptor is registered. */
export async function isPendingShareInviteToken(token: string): Promise<boolean> {
  return linkAcceptor ? linkAcceptor.isPending(token) : false;
}

/** Reserves a link token's invite for one sign-up; null when no link acceptor is registered. */
export async function claimShareInviteToken(token: string): Promise<Date | null> {
  return linkAcceptor ? linkAcceptor.claim(token) : null;
}

/** Accepts the invite a sign-up reserved; false when no link acceptor is registered. */
export async function acceptClaimedShareInviteToken(
  user: { id: string; email: string },
  token: string,
  claimedAt: Date,
): Promise<boolean> {
  return linkAcceptor ? linkAcceptor.accept(user, token, claimedAt) : false;
}

/** Better Auth routes that prove an e-mail (link verification and the e-mail OTP flow). */
export function isEmailVerificationPath(path: unknown): boolean {
  return path === "/verify-email" || path === "/email-otp/verify-email";
}
