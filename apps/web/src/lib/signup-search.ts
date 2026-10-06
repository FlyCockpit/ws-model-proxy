import { parseShareInviteToken } from "@ws-model-proxy/config/share-invite";

/**
 * Search-param contract for `/$lang/signup` (kept out of the route so it can be unit tested;
 * route files must not export anything).
 *
 * - `redirectTo`: where to go after sign-up.
 * - `invite`: a share invite link token (`?invite=wsmp_inv_…`). Only a well-formed token is kept;
 *   whether it is still pending is the server's answer (`auth.inviteInfo`).
 */
export type SignupSearch = {
  redirectTo: string | undefined;
  /** Optional so links to the plain sign-up page need not name it. */
  invite?: string | undefined;
};

/** The URL without its `invite` parameter (path, other params and hash kept); null if none. */
export function urlWithoutInvite(href: string): string | null {
  const url = new URL(href);
  if (!url.searchParams.has("invite")) return null;
  url.searchParams.delete("invite");
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Takes the invite token out of the address bar once the page has read it, so it does not stay
 * in history, bookmarks or a copied URL. The router state is kept as it is (the page holds the
 * token itself).
 */
export function stripInviteFromAddressBar(): void {
  if (typeof window === "undefined") return;
  const next = urlWithoutInvite(window.location.href);
  if (next !== null) window.history.replaceState(window.history.state, "", next);
}

export function parseSignupSearch(search: Record<string, unknown>): SignupSearch {
  return {
    redirectTo: typeof search.redirectTo === "string" ? search.redirectTo : undefined,
    invite: parseShareInviteToken(search.invite) ?? undefined,
  };
}
