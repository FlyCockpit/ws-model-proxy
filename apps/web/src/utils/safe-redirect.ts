import { parseShareInviteToken } from "@ws-model-proxy/config/share-invite";

/**
 * Validate a `redirectTo` search param so it can only point back into the
 * current locale's own routes (never to an external origin, never back to the
 * auth pages themselves). Falls back to the locale's dashboard.
 *
 * One exception: the invite page `/{lang}/signup?invite=<token>`, exactly, so a
 * signed-out person who chose "sign in" on an invite link comes back to accept it.
 */
export function safeRedirectTo(value: unknown, lang: string): string {
  if (typeof value !== "string") return `/${lang}/overview`;
  if (!value.startsWith(`/${lang}/`)) return `/${lang}/overview`;
  if (isInviteSignupPath(value, lang)) return value;
  if (value.startsWith(`/${lang}/login`)) return `/${lang}/overview`;
  if (value.startsWith(`/${lang}/signup`)) return `/${lang}/overview`;
  return value;
}

/** The sign-up page of an invite link, carrying the token so sign-in can come back to it. */
export function inviteSignupPath(lang: string, token: string): string {
  return `/${lang}/signup?invite=${token}`;
}

function isInviteSignupPath(value: string, lang: string): boolean {
  const prefix = `/${lang}/signup?invite=`;
  return value.startsWith(prefix) && parseShareInviteToken(value.slice(prefix.length)) !== null;
}
