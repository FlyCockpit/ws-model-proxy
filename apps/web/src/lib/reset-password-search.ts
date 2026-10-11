/**
 * Search-param contract for `/$lang/reset-password` (kept out of the route so it can be unit
 * tested; route files must not export anything).
 *
 * The emailed link goes to Better Auth's `/api/auth/reset-password/<token>`, which checks the
 * token and 302s here with `?token=<token>` (valid) or `?error=INVALID_TOKEN` (expired, used or
 * unknown). A bare visit has neither and is treated like a bad link.
 *
 * Better Auth's tokens are 24 letters and digits. The router parses search values with
 * `JSON.parse`, so an all-digit value would arrive as a (rounded) number: only strings of the
 * token alphabet are accepted, anything else reads as no token.
 */
export type ResetPasswordSearch = {
  token: string | undefined;
  error: string | undefined;
};

const TOKEN = /^[A-Za-z0-9_-]{1,256}$/;

export function parseResetPasswordSearch(search: Record<string, unknown>): ResetPasswordSearch {
  const token =
    typeof search.token === "string" && TOKEN.test(search.token) ? search.token : undefined;
  return {
    token,
    error: typeof search.error === "string" ? search.error : undefined,
  };
}

/**
 * The URL without its reset token, or null when there is none. The page reads the token from the
 * router first, then takes it out of the address bar so it does not stay in history, bookmarks or
 * a copied URL.
 */
export function urlWithoutResetToken(href: string): string | null {
  const url = new URL(href);
  if (!url.searchParams.has("token")) return null;
  url.searchParams.delete("token");
  return `${url.pathname}${url.search}${url.hash}`;
}

export function stripResetTokenFromAddressBar(): void {
  if (typeof window === "undefined") return;
  const next = urlWithoutResetToken(window.location.href);
  if (next !== null) window.history.replaceState(window.history.state, "", next);
}
