import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { MCP_REAUTH_STATUS_QUERY_KEY } from "@/lib/mcp-oauth-search";

/**
 * Sign-out for the MCP login page's tombstone-reauthorization branch
 * (Phase 6).
 *
 * `disableRedirect: true` and NO navigation: the signed `oauth_query` lives
 * in the CURRENT page URL, and keeping it there is what lets Better Auth's
 * `oauthProviderClient()` fetch plugin carry it through the new sign-in and
 * the session-cookie hook resume authorization with a new session-derived
 * grant generation. Navigating anywhere (including a "clean" reload with
 * rebuilt parameters) would either drop the signed query or require
 * reconstructing authorize parameters — both prohibited. After the cookie is
 * cleared, `useAuthSession` flips to anonymous and the route re-renders the
 * shared sign-in flow in place.
 *
 * Part H pass 2 (R83/R84 F4/F5/F8):
 * - Failures are SURFACED (`signOutFailed`) so the login page renders a
 *   localized failure message instead of silently reverting the button;
 *   the error object itself is never rendered or logged raw.
 * - The tombstone-probe query cache is INVALIDATED on successful sign-out
 *   (prefix key), so the next session can never reuse this session's cached
 *   reauth/continue decision.
 * - Single-flight: an in-flight `settled` ref guards re-entry — invoking the
 *   callback twice before settlement performs exactly one sign-out call.
 */
export function useMcpReauthSignOut() {
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const settled = useRef(false);
  const queryClient = useQueryClient();

  const signOutForReauth = useCallback(async () => {
    if (settled.current) return;
    settled.current = true;
    setIsSigningOut(true);
    setSignOutFailed(false);
    try {
      const result = await authClient.signOut({ disableRedirect: true });
      if (result.error) {
        // A failed sign-out leaves the session (and this card) in place; the
        // user can retry. Resolved { error } responses are surfaced to the UI
        // as a localized failure state (R83/R84 F4).
        setSignOutFailed(true);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: [MCP_REAUTH_STATUS_QUERY_KEY] });
    } catch {
      setSignOutFailed(true);
    } finally {
      setIsSigningOut(false);
      settled.current = false;
    }
  }, [queryClient]);

  return { signOutForReauth, isSigningOut, signOutFailed };
}
