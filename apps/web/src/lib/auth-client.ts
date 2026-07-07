import type { auth } from "@ws-model-proxy/auth";
import { env } from "@ws-model-proxy/env/web";
import {
  adminClient,
  deviceAuthorizationClient,
  genericOAuthClient,
  inferAdditionalFields,
  twoFactorClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  baseURL: env.VITE_SERVER_URL,
  plugins: [
    // Surface server-side `user.additionalFields` (e.g. `locale`) on the
    // typed session. Without this, `session.user.locale` is unknown to the
    // type system even though the runtime payload includes it.
    inferAdditionalFields<typeof auth>(),
    adminClient(),
    twoFactorClient(),
    genericOAuthClient(),
    deviceAuthorizationClient(),
  ],
});
