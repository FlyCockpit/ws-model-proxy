import { useCallback, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";

import { authClient } from "@/lib/auth-client";
import {
  type AuthSessionData,
  classifyAuthSession,
  nextConfirmedAuthSession,
  rememberConfirmedAnonymous,
} from "@/lib/auth-session-state";
import {
  announceDocumentIdentity,
  confirmDocumentIdentityFresh,
  identityVerificationGeneration,
  isDocumentIdentityUnverified,
  observeDocumentIdentity,
  replaceDocument,
  subscribeIdentityVerification,
} from "@/lib/document-identity";
import { connectSessionRetry, observeSessionRetry } from "@/lib/session-retry";
import { useNetworkStatus } from "./use-network-status";

/**
 * Whether Better Auth's session atom has settled anonymous in this document. Module-level because
 * the atom is: every caller reads the same session, so a component that mounts during a refetch
 * (a navigation from /login to /signup while the tab regains focus) must not see a first load
 * either. Only browser snapshots write it; the server's are always the unresolved initial state.
 * A sign-in turns it off; a sign-out replaces the document (`signOutAndLeave`), which resets it.
 */
let confirmedAnonymous = false;
let unavailableError: unknown | null = null;

/**
 * True while another tab's identity change (or a 401) is unchecked in this document
 * (`isDocumentIdentityUnverified`): nothing may show an account or the previous account's page
 * until a fresh check settles it. docs/ui.md § Query cache follows identity.
 */
export function useIdentityUnverified(): boolean {
  return useSyncExternalStore(
    subscribeIdentityVerification,
    isDocumentIdentityUnverified,
    () => false,
  );
}

/**
 * The sole application adapter for Better Auth's reactive session atom. While another tab's
 * identity change (or a 401) is unchecked here (`isDocumentIdentityUnverified`), it reports
 * `pending` whatever the atom holds, so no chrome shows an account this document has not
 * confirmed. `unmasked` is for the identity watcher only: it must see the raw session even then,
 * to notice the answer that settles it. docs/ui.md § Query cache follows identity.
 */
export function useAuthSession({ unmasked = false }: { unmasked?: boolean } = {}) {
  const session = authClient.useSession();
  const isOnline = useNetworkStatus();
  const unverified = useIdentityUnverified();
  if (typeof window !== "undefined") {
    if (session.error) unavailableError = session.error;
    else if (!session.isPending && !session.isRefetching) unavailableError = null;
  }
  const error =
    session.error ?? (session.isPending || session.isRefetching ? unavailableError : null);
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

  // Better Auth's refetch is one function for the atom's life; the snapshot around it is new on
  // every change. Keyed by the function, so the watcher's checks (keyed by `refetch`) are not
  // restarted, and their answers dropped, by the very refetch they start.
  const { refetch: refetchSession } = session;
  const refetch = useCallback(async () => {
    const since = identityVerificationGeneration();
    const result = await refetchSession();
    const checked = readSessionIdentity();
    if (since === identityVerificationGeneration() && checked !== undefined) {
      if (observeDocumentIdentity(checked)) replaceDocument();
      else {
        confirmDocumentIdentityFresh(since);
        announceDocumentIdentity(checked);
      }
    }
    return result;
  }, [refetchSession]);
  useLayoutEffect(() => connectSessionRetry(refetch), [refetch]);
  useLayoutEffect(() => {
    observeSessionRetry(session.error, session.isPending || session.isRefetching);
  }, [session.error, session.isPending, session.isRefetching]);
  const actions = useMemo(() => ({ refetch, retry: refetch }), [refetch]);

  if (!unmasked && unverified) {
    return classifyAuthSession({
      data: null,
      error,
      isPending: error == null,
      isRefetching: session.isRefetching,
      isOffline: !isOnline,
      actions,
    });
  }

  const result = classifyAuthSession({
    data,
    confirmedSession: nextConfirmed,
    confirmedAnonymous,
    isRefetching: session.isRefetching,
    isPending: session.isPending,
    error,
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

/**
 * The atom's confirmed identity right now, outside React (the watcher reads it after its own
 * refetch settles): the user id, `null` when confirmed signed out, `undefined` while unknown
 * (pending, or a failed check).
 */
export function readSessionIdentity(): string | null | undefined {
  const snapshot = authClient.$store.atoms.session?.get();
  if (!snapshot || snapshot.isPending || snapshot.isRefetching) return undefined;
  if (snapshot.error) {
    // A 401 confirms the session is gone; any other failure confirms nothing, even with the
    // previous answer still retained in `data`.
    return (snapshot.error as { status?: unknown }).status === 401 ? null : undefined;
  }
  const data = snapshot.data as AuthSessionData | null;
  return data ? data.user.id : null;
}

/** A session fetch is in flight right now (another one superseded ours). */
export function isSessionFetchInFlight(): boolean {
  const snapshot = authClient.$store.atoms.session?.get();
  return snapshot ? snapshot.isPending || snapshot.isRefetching : false;
}

/** Forget the settled state, as a new document would. Tests only. */
export function resetAuthSessionMemoryForTests(): void {
  confirmedAnonymous = false;
  unavailableError = null;
}
