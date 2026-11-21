import { useEffect, useRef } from "react";

import { useAuthSession } from "@/hooks/use-auth-session";
import type { AuthSessionState } from "@/lib/auth-session-state";

/**
 * Who the in-memory app state belongs to: the user id when signed in, `null`
 * when confirmed anonymous, and `undefined` while that is not known (session
 * pending or errored). `undefined` is never acted on — a flaky session check
 * must not reload a signed-in user's page.
 */
export type SessionIdentity = string | null | undefined;

export function sessionIdentity(state: AuthSessionState["state"]): SessionIdentity {
  if (state.status === "authenticated") return state.session.user.id;
  if (state.status === "anonymous") return null;
  return undefined;
}

/**
 * True when a signed-in user's in-memory state must be dropped: the last known
 * identity was a user and the next known identity is a different user or
 * anonymous. Anonymous → signed in is not a leak (an anonymous cache only holds
 * public data), and transitions through `undefined` compare against the last
 * known identity, so pending → same user never reloads.
 */
export function shouldReloadForIdentity(
  lastKnown: SessionIdentity,
  next: SessionIdentity,
): boolean {
  return typeof lastKnown === "string" && next !== undefined && next !== lastKnown;
}

/**
 * Reloads the page when the signed-in user goes away without this tab asking
 * (sign-out in another tab, session expiry or revocation, an account switch).
 * A full load is the one reset that is always complete: the TanStack Query
 * cache, Zustand stores and module state all start empty, and no mounted
 * observer is left pointing at a query that was cleared out from under it
 * (`queryClient.clear()` with live observers can leave a page stuck pending).
 * The route guards then send the visitor wherever the new identity belongs.
 * Explicit sign-out does the same with `window.location.assign`. Mounted once,
 * by the root shell, covering app and admin routes.
 */
let explicitSignOutInProgress = false;

/**
 * Call right before an explicit sign-out that ends in its own full page load,
 * so this hook doesn't race it with a reload of the signed-out page (which
 * would cost an extra load and leave a `redirectTo` to the old user's page).
 */
export function markExplicitSignOut(): () => void {
  explicitSignOutInProgress = true;
  // If the sign-out request fails, the user is still signed in here: undo.
  return () => {
    explicitSignOutInProgress = false;
  };
}

export function useReloadOnIdentityChange(): void {
  const identity = sessionIdentity(useAuthSession().state);
  const lastKnown = useRef<SessionIdentity>(undefined);

  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      // The sign-out navigation did not discard this document's caches. Even
      // if anonymous was already observed, they still belong to the old user.
      if (event.persisted && explicitSignOutInProgress) window.location.reload();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  useEffect(() => {
    if (identity === undefined) return;
    const reload = shouldReloadForIdentity(lastKnown.current, identity);
    lastKnown.current = identity;
    if (reload && !explicitSignOutInProgress) window.location.reload();
  }, [identity]);
}
