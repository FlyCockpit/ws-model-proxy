import { useCallback, useMemo, useRef } from "react";

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
  const confirmedSession = useRef<AuthSessionData | null>(null);

  if (session.data?.user) {
    confirmedSession.current = session.data as AuthSessionData;
  } else {
    confirmedSession.current = nextConfirmedAuthSession(confirmedSession.current, {
      data: session.data as AuthSessionData | null | undefined,
      isPending: session.isPending,
      error: session.error,
    });
  }

  const refetch = useCallback(() => session.refetch(), [session]);
  const actions = useMemo(() => ({ refetch, retry: refetch }), [refetch]);

  return classifyAuthSession({
    data: session.data as AuthSessionData | null | undefined,
    confirmedSession: confirmedSession.current,
    isPending: session.isPending,
    error: session.error,
    isOffline: !isOnline,
    actions,
  });
}
