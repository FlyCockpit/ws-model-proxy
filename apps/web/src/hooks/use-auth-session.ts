import { useCallback, useMemo, useState } from "react";

import { authClient } from "@/lib/auth-client";
import {
  type AuthSessionData,
  classifyAuthSession,
  nextConfirmedAuthSession,
  rememberConfirmedAnonymous,
} from "@/lib/auth-session-state";
import { useNetworkStatus } from "./use-network-status";

/**
 * Whether Better Auth's session atom has settled anonymous in this document. Module-level because
 * the atom is: every caller reads the same session, so a component that mounts during a refetch
 * (a navigation from /login to /signup while the tab regains focus) must not see a first load
 * either. Only browser snapshots write it; the server's are always the unresolved initial state.
 * A sign-in turns it off; a sign-out replaces the document (`signOutAndLeave`), which resets it.
 */
let confirmedAnonymous = false;

export function useAuthSession() {
  const session = authClient.useSession();
  const isOnline = useNetworkStatus();
  const data = session.data as AuthSessionData | null | undefined;

  // The last session the server confirmed, kept through a refetch or a transient error. It is
  // derived from the previous render's value (React's "store information from previous renders"
  // pattern): state, not a ref, so a render React discards never leaks into it. The render that
  // changes it is restarted at once with the new value, before anything commits.
  const [confirmedSession, setConfirmedSession] = useState<AuthSessionData | null>(null);
  const nextConfirmed = nextConfirmedAuthSession(confirmedSession, {
    data,
    isPending: session.isPending,
    error: session.error,
  });
  if (nextConfirmed !== confirmedSession) setConfirmedSession(nextConfirmed);

  const refetch = useCallback(() => session.refetch(), [session]);
  const actions = useMemo(() => ({ refetch, retry: refetch }), [refetch]);

  const result = classifyAuthSession({
    data,
    confirmedSession: nextConfirmed,
    confirmedAnonymous,
    isPending: session.isPending,
    error: session.error,
    isOffline: !isOnline,
    actions,
  });
  // A fact about the shared atom, not about this render: idempotent, and the same for every
  // caller that reads this snapshot.
  if (typeof window !== "undefined") {
    confirmedAnonymous = rememberConfirmedAnonymous(confirmedAnonymous, result);
  }
  return result;
}

/** Forget the settled state, as a new document would. Tests only. */
export function resetAuthSessionMemoryForTests(): void {
  confirmedAnonymous = false;
}
