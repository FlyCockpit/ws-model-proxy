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

/**
 * The URL without an invite token: its `invite` parameter (the sign-up page) and a `redirectTo`
 * that carries one (the login page, coming back to an invite). Path, other params and hash are
 * kept; null when there is nothing to remove.
 */
export function urlWithoutInvite(href: string): string | null {
  const url = new URL(href);
  const redirectTo = url.searchParams.get("redirectTo");
  const redirectCarriesInvite = redirectTo !== null && /[?&]invite=/.test(redirectTo);
  if (!url.searchParams.has("invite") && !redirectCarriesInvite) return null;
  url.searchParams.delete("invite");
  if (redirectCarriesInvite) url.searchParams.delete("redirectTo");
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Takes the invite token out of the address bar once the page has read it, so it does not stay
 * in history, bookmarks or a copied URL (the current history entry is replaced). The router
 * state is kept as it is: the page already read its search params.
 */
export function stripInviteFromAddressBar(): void {
  if (typeof window === "undefined") return;
  const next = urlWithoutInvite(window.location.href);
  if (next !== null) window.history.replaceState(window.history.state, "", next);
}

export function parseSignupSearch(search: Record<string, unknown>): SignupSearch {
  const redirectTo = typeof search.redirectTo === "string" ? search.redirectTo : undefined;
  const invite = parseShareInviteToken(search.invite);
  if (invite) return { redirectTo, invite };
  // "Need an account?" from a login page that came from an invite link: the invite is back
  // in `redirectTo` (`/{lang}/signup?invite=<token>`); sign up through it instead.
  const carried = /^\/[^/?#]+\/signup\?invite=([^&#]*)$/.exec(redirectTo ?? "")?.[1];
  const carriedInvite = carried ? parseShareInviteToken(carried) : null;
  if (carriedInvite) return { redirectTo: undefined, invite: carriedInvite };
  return { redirectTo, invite: undefined };
}
