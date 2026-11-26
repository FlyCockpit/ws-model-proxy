import { useCallback, useRef, useState } from "react";
import { signOutAndLeave } from "@/lib/explicit-sign-out";

/**
 * Sign-out for the MCP login page's tombstone-reauthorization branch
 * (Phase 6).
 *
 * `disableRedirect: true` preserves the signed `oauth_query` in the current
 * URL. Success reloads that exact URL (`signOutAndLeave()` without a
 * destination: the document is quarantined first, its QueryClient sealed, so
 * no previous-identity client state survives, this session's cached
 * reauth/continue decision included) before the shared sign-in flow resumes
 * authorization.
 *
 * Part H pass 2 (R83/R84 F4/F5/F8):
 * - Failures are SURFACED (`signOutFailed`) so the login page renders a
 *   localized failure message instead of silently reverting the button;
 *   the error object itself is never rendered or logged raw.
 * - Single-flight: the status is one `idle | signing | failed | done` union,
 *   mirrored in a ref so re-entry is refused synchronously — invoking the
 *   callback twice before settlement performs exactly one sign-out call.
 *   `failed` and `done` are not terminal: a later call is a new flight.
 */
export type McpReauthSignOutStatus = "idle" | "signing" | "failed" | "done";

export function useMcpReauthSignOut() {
  const [status, setStatusState] = useState<McpReauthSignOutStatus>("idle");
  const statusRef = useRef<McpReauthSignOutStatus>("idle");

  const setStatus = useCallback((next: McpReauthSignOutStatus) => {
    statusRef.current = next;
    setStatusState(next);
  }, []);

  const signOutForReauth = useCallback(async () => {
    if (statusRef.current === "signing") return;
    setStatus("signing");
    // A failed sign-out (returned or thrown) leaves the session (and this
    // card) in place; the user can retry (R83/R84 F4).
    const result = await signOutAndLeave(undefined, { disableRedirect: true });
    setStatus(result.ok ? "done" : "failed");
  }, [setStatus]);

  return {
    signOutForReauth,
    status,
    isSigningOut: status === "signing",
    signOutFailed: status === "failed",
  };
}
