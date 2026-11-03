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
 * - Single-flight: the status is one `idle | signing | failed | done` union,
 *   mirrored in a ref so re-entry is refused synchronously — invoking the
 *   callback twice before settlement performs exactly one sign-out call.
 *   `failed` and `done` are not terminal: a later call is a new flight.
 */
export type McpReauthSignOutStatus = "idle" | "signing" | "failed" | "done";

export function useMcpReauthSignOut() {
  const [status, setStatusState] = useState<McpReauthSignOutStatus>("idle");
  const statusRef = useRef<McpReauthSignOutStatus>("idle");
  const queryClient = useQueryClient();

  const setStatus = useCallback((next: McpReauthSignOutStatus) => {
    statusRef.current = next;
    setStatusState(next);
  }, []);

  const signOutForReauth = useCallback(async () => {
    if (statusRef.current === "signing") return;
    setStatus("signing");
    try {
      const result = await authClient.signOut({ disableRedirect: true });
      if (result.error) {
        // A failed sign-out leaves the session (and this card) in place; the
        // user can retry. Resolved { error } responses are surfaced to the UI
        // as a localized failure state (R83/R84 F4).
        setStatus("failed");
        return;
      }
      await queryClient.invalidateQueries({ queryKey: [MCP_REAUTH_STATUS_QUERY_KEY] });
      setStatus("done");
    } catch {
      setStatus("failed");
    }
  }, [queryClient, setStatus]);

  return {
    signOutForReauth,
    status,
    isSigningOut: status === "signing",
    signOutFailed: status === "failed",
  };
}
