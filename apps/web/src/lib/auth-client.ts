import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import type { auth } from "@ws-model-proxy/auth";
import { APP_LOCALE_HEADER } from "@ws-model-proxy/config/locales";
import { env } from "@ws-model-proxy/env/web";
import { adminClient, inferAdditionalFields, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import i18n from "@/i18n";
import {
  announceSessionChange,
  confirmAuthoritativeSessionCheck,
  confirmOutsideAppIdentity,
  guardIdentityResponse,
  identityVerificationGeneration,
  needsAuthoritativeSessionCheck,
  withExpectedIdentity,
} from "@/lib/document-identity";

import {
  connectSessionRetry,
  observeSessionRetry,
  recordSessionRetryAfter,
  runSessionCheck,
  trackNativeSessionCheck,
  waitForSessionCooldown,
} from "@/lib/session-retry";

const authoritativeRequests = new WeakMap<object, number>();

export const authClient = createAuthClient({
  baseURL: env.VITE_SERVER_URL,
  fetchOptions: {
    // Tell the server which locale the user is actually using so signup can
    // seed User.locale (and verification email language) from `/$lang/`.
    // Shared with the server's CORS allowHeaders via APP_LOCALE_HEADER.
    async onRequest(context) {
      context.headers.set(APP_LOCALE_HEADER, i18n.language);
      const path = new URL(context.url).pathname;
      // Native reconnect/storage/mount refreshes bypass runSessionCheck.
      // Share their entire atom update with it, including cooldown waits.
      if (path.endsWith("/get-session")) {
        const signal = context.signal;
        if (signal) trackSessionAtomRefresh(signal);
        await waitForSessionCooldown(signal);
        if (needsAuthoritativeSessionCheck()) {
          const url = new URL(context.url);
          url.searchParams.set("disableCookieCache", "true");
          context.url = url;
          authoritativeRequests.set(context, identityVerificationGeneration());
        }
      }
      if (!/\/(get-session|sign-out)\/?$/.test(path)) {
        context.headers = withExpectedIdentity(context.headers);
      }
      return context;
    },
    async onResponse({ response, request }) {
      const path = new URL(request.url).pathname;
      // An explicit sign-out owns its navigation even if a peer replaced the
      // identity meanwhile. Its success callback must still leave for login.
      if (path.endsWith("/sign-out")) return;
      if (path.endsWith("/get-session")) {
        recordSessionRetryAfter(response);
        const since = authoritativeRequests.get(request);
        if (response.status === 401 && since !== undefined) confirmAuthoritativeSessionCheck(since);
      }
      await guardIdentityResponse(response);
    },
    // Clear the targeted bypass only after a parsed successful session answer.
    onSuccess({ request }) {
      const since = authoritativeRequests.get(request);
      if (since !== undefined) confirmAuthoritativeSessionCheck(since);
    },
  },
  sessionOptions: {
    refetchOnWindowFocus: false,
    refetchWhenOffline: false,
    refetchInterval: 0,
  },
  plugins: [
    // Surface server-side `user.additionalFields` (e.g. `locale`) on the
    // typed session. Without this, `session.user.locale` is unknown to the
    // type system even though the runtime payload includes it.
    inferAdditionalFields<typeof auth>(),
    adminClient(),
    twoFactorClient(),
    // Better Auth 1.7 removed `genericOAuthClient`. This plugin carries the
    // signed `oauth_query` through sign-in, 2FA, consent, and continuation.
    oauthProviderClient(),
  ],
});

function trackSessionAtomRefresh(signal: AbortSignal): void {
  const session = authClient.$store.atoms.session;
  // Reading value avoids mounting the atom for an imperative getSession().
  // Listening mounts a nanostore. An imperative public probe has no mounted
  // atom and already owns runSessionCheck; mounting here would start Better
  // Auth's own initial fetch and could supersede the probe (or its 429 wait).
  if (!session?.value.isRefetching || session.lc === 0) return;
  const finish = trackNativeSessionCheck();
  const stop = () => {
    unlisten();
    signal.removeEventListener("abort", stop);
    finish();
  };
  const unlisten = session.listen((snapshot) => {
    if (!snapshot.isPending && !snapshot.isRefetching) stop();
  });
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
}

// A session change made in this tab (sign-in, 2FA, sign-up, …: Better Auth's
// session signal) is announced to the other open tabs before the flow
// navigates anywhere, so they re-check whose session the shared cookie holds
// now, whatever page this tab lands on. docs/ui.md § Query cache follows
// identity.
authClient.$store.atoms.$sessionSignal?.listen(() => announceSessionChange());

// Before the root watcher mounts, pending/error surfaces may have no session
// atom listener. Lazy reconciliation shares its coordinator and retry budget.
let disconnectOutsideRetry: (() => void) | undefined;
async function probeOutsideAppSession(): Promise<void> {
  const since = identityVerificationGeneration();
  const atom = authClient.$store.atoms.session;
  if (!atom) return;
  // Update the same atom the watcher consumes. If the app mounts during this
  // request, joining its coordinator slot must never read an older atom.
  await atom.value.refetch();
  const snapshot = atom.value;
  const pending = snapshot.isPending || snapshot.isRefetching;
  observeSessionRetry(snapshot.error, pending);
  if (pending || since !== identityVerificationGeneration()) return;
  if (snapshot.error && snapshot.error.status !== 401) return;
  disconnectOutsideRetry?.();
  disconnectOutsideRetry = undefined;
  confirmOutsideAppIdentity(snapshot.data?.user.id ?? null, since);
}
export async function checkDocumentSession(): Promise<void> {
  disconnectOutsideRetry?.();
  // Register the raw transport, never a callback that recursively joins its
  // own in-flight coordinator promise when the failure scheduler invokes it.
  disconnectOutsideRetry = connectSessionRetry(probeOutsideAppSession);
  for (let attempt = 0; attempt < 3; attempt++) {
    const since = identityVerificationGeneration();
    const ran = await runSessionCheck(probeOutsideAppSession, { automatic: true });
    if (!ran || since === identityVerificationGeneration()) return;
  }
}
