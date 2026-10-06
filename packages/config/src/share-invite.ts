/**
 * Share invite link contract, shared by the web sign-up page, the server's sign-up gate and
 * Better Auth's user-create hooks.
 *
 * The token (`wsmp_inv_` + 26 base32 characters) arrives in the page URL
 * (`/{lang}/signup?invite=<token>`); the sign-up request carries it in {@link SHARE_INVITE_HEADER},
 * never in an API URL.
 */
export const SHARE_INVITE_TOKEN_PATTERN = /^wsmp_inv_[A-Z2-7]{26}$/;

/** Request header of an invite sign-up. Shared with the server's CORS `allowHeaders`. */
export const SHARE_INVITE_HEADER = "x-wsmp-invite";

/** The value as an invite token when it has the token's shape; otherwise null. */
export function parseShareInviteToken(value: unknown): string | null {
  return typeof value === "string" && SHARE_INVITE_TOKEN_PATTERN.test(value) ? value : null;
}

/** The invite token a request carries in {@link SHARE_INVITE_HEADER}, or null. */
export function shareInviteTokenFromHeaders(headers: Headers | null | undefined): string | null {
  return parseShareInviteToken(headers?.get(SHARE_INVITE_HEADER));
}
