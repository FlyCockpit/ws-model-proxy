import { useCallback, useMemo, useState } from "react";

import { authClient } from "@/lib/auth-client";
import {
  type AuthSessionData,
  classifyAuthSession,
  nextConfirmedAuthSession,
} from "@/lib/auth-session-state";
import { useNetworkStatus } from "./use-network-status";

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

  return classifyAuthSession({
    data,
    confirmedSession: nextConfirmed,
    isPending: session.isPending,
    error: session.error,
    isOffline: !isOnline,
    actions,
  });
}
