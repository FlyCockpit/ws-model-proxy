import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import type { auth } from "@ws-model-proxy/auth";
import { APP_LOCALE_HEADER } from "@ws-model-proxy/config/locales";
import { env } from "@ws-model-proxy/env/web";
import { adminClient, inferAdditionalFields, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import i18n from "@/i18n";
import { announceSessionChange } from "@/lib/document-identity";

export const authClient = createAuthClient({
  baseURL: env.VITE_SERVER_URL,
  fetchOptions: {
    // Tell the server which locale the user is actually using so signup can
    // seed User.locale (and verification email language) from `/$lang/`.
    // Shared with the server's CORS allowHeaders via APP_LOCALE_HEADER.
    onRequest(context) {
      context.headers.set(APP_LOCALE_HEADER, i18n.language);
      return context;
    },
  },
  sessionOptions: {
    refetchOnWindowFocus: true,
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

// A session change made in this tab (sign-in, 2FA, sign-up, …: Better Auth's
// session signal) is announced to the other open tabs before the flow
// navigates anywhere, so they re-check whose session the shared cookie holds
// now, whatever page this tab lands on. docs/ui.md § Query cache follows
// identity.
authClient.$store.atoms.$sessionSignal?.listen(() => announceSessionChange());
