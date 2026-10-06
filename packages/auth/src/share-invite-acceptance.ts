/**
 * Where Better Auth hands a proven e-mail to share-invite acceptance. The acceptance itself
 * (database writes, the `inviteAcceptance` rule) lives in `@ws-model-proxy/api`
 * (`lib/share-invite-accept.ts`), which registers itself here when the API router loads; this
 * package cannot depend on the API package.
 */
export type ShareInviteAcceptor = (user: {
  id: string;
  email: string;
  /** True only when the address is proven (verified with e-mail verification on). */
  emailVerified: boolean;
}) => Promise<number>;

let acceptor: ShareInviteAcceptor | null = null;

export function registerShareInviteAcceptor(next: ShareInviteAcceptor): void {
  acceptor = next;
}

/** Accepts the pending invites to a proven e-mail; 0 when no acceptor is registered. */
export async function acceptShareInvitesForProvenEmail(
  user: Parameters<ShareInviteAcceptor>[0],
): Promise<number> {
  return acceptor ? acceptor(user) : 0;
}

/** Better Auth routes that prove an e-mail (link verification and the e-mail OTP flow). */
export function isEmailVerificationPath(path: unknown): boolean {
  return path === "/verify-email" || path === "/email-otp/verify-email";
}
