import {
  APP_LOCALE_HEADER,
  DEFAULT_LOCALE,
  isSupportedLocale,
  type Locale,
} from "@ws-model-proxy/config/locales";

/**
 * Resolve the locale to seed on a freshly created user row.
 *
 * Reads the locale the client is actually rendering (the APP_LOCALE_HEADER set
 * in apps/web/src/lib/auth-client.ts), not the Prisma default. `sendOnSignUp`
 * fires immediately after the user-create hook and reads the row back, so this
 * is what decides whether a user who signed up on /es-MX/signup gets a Spanish
 * verification email and lands on /es-MX/verify-email.
 */
export function resolveSignupLocale(headers: Headers | null | undefined): Locale {
  const requested = headers?.get(APP_LOCALE_HEADER);
  return isSupportedLocale(requested) ? requested : DEFAULT_LOCALE;
}
