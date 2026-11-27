import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import type { auth } from "@ws-model-proxy/auth";
import { APP_LOCALE_HEADER } from "@ws-model-proxy/config/locales";
import { env } from "@ws-model-proxy/env/web";
import { adminClient, inferAdditionalFields, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import i18n from "@/i18n";
import {
  announceSessionChange,
  guardIdentityResponse,
  withExpectedIdentity,
} from "@/lib/document-identity";

import {
  recordSessionRetryAfter,
  trackNativeSessionCheck,
  waitForSessionCooldown,
} from "@/lib/session-retry";

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
      }
      await guardIdentityResponse(response);
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
  if (!session?.value.isRefetching) return;
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
