import { APP_LOCALE_HEADER } from "@ws-model-proxy/config/locales";
import { SHARE_INVITE_HEADER } from "@ws-model-proxy/config/share-invite";

/**
 * Request headers the browser is allowed to send cross-origin.
 *
 * Every header the client sets on a cross-origin request must appear here. A
 * custom header that isn't listed makes the browser's preflight fail, and the
 * real request is never sent — so the failure surfaces as "sign-in silently
 * does nothing", not as a readable error.
 *
 * This is easy to get wrong because the CORS middleware only mounts when
 * `CORS_ORIGIN` is set, and local development proxies the API same-origin
 * through Vite. An omission here therefore passes every local check and breaks
 * authentication on the first split-origin production deploy.
 *
 * Current entries and who sends them:
 *   - `Content-Type` / `Authorization` — standard.
 *   - `x-csrf-token` — Better-Auth's SimpleCsrfProtectionLinkPlugin, every request.
 *   - APP_LOCALE_HEADER — the auth client (apps/web/src/lib/auth-client.ts),
 *     every auth request.
 *   - SHARE_INVITE_HEADER — the sign-up page (apps/web/src/routes/$lang/signup.tsx) on an
 *     invite sign-up.
 *
 * **Adding a client-set header means adding it here.** cors-headers.test.ts
 * asserts the preflight actually echoes each one.
 */
export const CORS_ALLOW_HEADERS = [
  "Content-Type",
  "Authorization",
  // The model API also takes the key as x-api-key (Anthropic SDKs) or api-key (Azure style).
  "x-api-key",
  "api-key",
  "x-csrf-token",
  APP_LOCALE_HEADER,
  SHARE_INVITE_HEADER,
] as const;
