import { useLayoutEffect } from "react";

import {
  isSessionFetchInFlight,
  readSessionIdentity,
  useAuthSession,
} from "@/hooks/use-auth-session";
import type { AuthSessionState } from "@/lib/auth-session-state";
import {
  announceDocumentIdentity,
  confirmDocumentIdentityFresh,
  connectIdentityPeers,
  identityVerificationGeneration,
  isDocumentIdentityUnverified,
  isDocumentReplaced,
  observeDocumentIdentity,
  replaceDocument,
  type SessionIdentity,
} from "@/lib/document-identity";

import { runSessionCheck } from "@/lib/session-retry";

/**
 * `undefined` (session pending or errored) is never acted on: a flaky session
 * check must not reload a signed-in user's page.
 */
export function sessionIdentity(state: AuthSessionState["state"]): SessionIdentity {
  if (state.status === "authenticated") return state.session.user.id;
  if (state.status === "anonymous") return null;
  return undefined;
}

/**
 * The watcher's session checks while it is mounted: for a peer tab's
 * announcement, a 401, and an unverified identity (another tab announced a
 * change while no watcher was mounted: the chrome shows no account until a
 * check settles it). Checks share the document's retry coordinator and must
 * start after the invalidation they verify (`since`). The adapter's stable
 * refetch wrapper also verifies retries started by the header or scheduler.
 * A failed check is retried with backoff and when the tab regains focus,
 * visibility or the network; one superseded by another fetch still running is
 * followed up (at most 3 times, 250 ms apart), with one timer shared by all
 * callers. A current-generation confirmation makes its queued follow-up
 * unnecessary. Peer checks also run while hidden or offline; availability
 * gates only focus/visibility/reconnect checks and scheduled failure retries.
 * `stop()` drops every pending completion, deferred probe, timer and listener.
 */
function startIdentityChecks(refetch: () => unknown): { stop: () => void } {
  let connected = true;
  let followUp: ReturnType<typeof setTimeout> | undefined;
  const queueFollowUp = (superseded: number) => {
    if (superseded >= 3 || followUp !== undefined) return;
    const unverifiedOnly = isDocumentIdentityUnverified();
    followUp = setTimeout(() => {
      followUp = undefined;
      void check(superseded + 1, unverifiedOnly).catch(() => {});
    }, 250);
  };
  const check = (superseded = 0, unverifiedOnly = false): Promise<void> => {
    const cancelled = () =>
      !connected || isDocumentReplaced() || (unverifiedOnly && !isDocumentIdentityUnverified());
    if (cancelled()) return Promise.resolve();
    let since = identityVerificationGeneration();
    return runSessionCheck(
      () => {
        // The coordinator may wait for an older native refresh before starting
        // this fresh probe. Verify the generation it actually starts in.
        since = identityVerificationGeneration();
        return refetch();
      },
      { automatic: true, cancelled },
    ).then((ran) => {
      if (!ran || !connected || isDocumentReplaced()) return;
      if (since !== identityVerificationGeneration()) {
        if (isDocumentIdentityUnverified()) queueFollowUp(superseded);
        return;
      }
      const checked = readSessionIdentity();
      if (checked === undefined) {
        if (isSessionFetchInFlight()) queueFollowUp(superseded);
        return;
      }
      clearTimeout(followUp);
      followUp = undefined;
      if (observeDocumentIdentity(checked)) replaceDocument();
      else {
        confirmDocumentIdentityFresh(since);
        announceDocumentIdentity(checked);
      }
    });
  };
  const retry = () => {
    // Settled anonymous forms/public tabs have no private owner to reconcile.
    // Peer hints and failed/pending checks still carry an explicit obligation.
    if (readSessionIdentity() === null && !isDocumentIdentityUnverified()) return;
    if (document.visibilityState !== "hidden" && navigator.onLine !== false)
      void check().catch(() => {});
  };
  const disconnectPeers = connectIdentityPeers(() => check());
  if (isDocumentIdentityUnverified()) void check().catch(() => {});
  window.addEventListener("focus", retry);
  window.addEventListener("online", retry);
  document.addEventListener("visibilitychange", retry);
  return {
    stop: () => {
      connected = false;
      clearTimeout(followUp);
      disconnectPeers();
      window.removeEventListener("focus", retry);
      window.removeEventListener("online", retry);
      document.removeEventListener("visibilitychange", retry);
    },
  };
}

/**
 * Replaces the document when the signed-in user goes away while a page is
 * open (sign-out in another tab, session expiry or revocation, another account
 * signing in). The identity the document belongs to lives in
 * `lib/document-identity.ts`, not here, so it survives this shell unmounting;
 * the route guards check the same baseline before anything renders, which
 * covers a change made while no `_app` page was open. Mounted once, by the root shell, including unguarded auth pages.
 *
 * It also connects the other open tabs: an identity this tab confirms (a
 * sign-in included, which Better Auth does not broadcast) asks conflicting
 * peers to verify their session here, alongside change hints and requests
 * rejected for having no session (`reportSessionRejected`).
 */
export function useReloadOnIdentityChange(): void {
  // Raw, never masked: the identity effect below must see the session even
  // while the chrome is held neutral.
  const authSession = useAuthSession({ unmasked: true });
  const identity = sessionIdentity(authSession.state);
  const since = identityVerificationGeneration();
  const { isDegraded, isRefetching } = authSession.meta;
  const { refetch } = authSession.actions;

  // Connected first (effects run in order), so the first identity below is
  // already announced to the other tabs.
  useLayoutEffect(() => {
    const watcher = startIdentityChecks(refetch);
    return () => watcher.stop();
  }, [refetch]);

  // Layout effect: replace the document before the browser paints a frame
  // that pairs the new identity's chrome with the old identity's cached data.
  useLayoutEffect(() => {
    // Retained presentation data is not a new confirmation. In particular a
    // remount after a peer invalidation must wait for its own current probe.
    if (
      identity === undefined ||
      isDegraded ||
      isRefetching ||
      isDocumentIdentityUnverified() ||
      since !== identityVerificationGeneration()
    )
      return;
    if (observeDocumentIdentity(identity)) {
      replaceDocument();
      return;
    }
    // Only the settled, successful atom answer can be broadcast. The
    // presentation adapter may retain an identity through a failed check.
    if (readSessionIdentity() === identity) announceDocumentIdentity(identity);
  }, [identity, isDegraded, isRefetching, since]);
}
