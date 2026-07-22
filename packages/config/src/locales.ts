/**
 * Shared locale constants. Imported by both the web app's i18n config and the
 * API package so the two stay in lockstep. Adding a locale is a single edit
 * here.
 *
 * Adding a locale:
 *   1. Append the BCP 47 tag to `SUPPORTED_LOCALES`.
 *   2. Drop matching translation JSON files into `apps/web/src/locales/<tag>/`.
 * No DB migration is required — `User.locale` is a free-form String column,
 * validated at the API boundary by this list.
 */
export const SUPPORTED_LOCALES = ["en-US", "es-MX"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en-US";

export function isSupportedLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Request header carrying the locale the client is actually rendering.
 *
 * The auth client sets this on every request so signup can seed `User.locale`
 * (and therefore verification / reset email language) from the `/$lang/` the
 * user is on, not the Prisma default. Shared with the server's CORS
 * `allowHeaders` list — a custom header the server doesn't allow fails
 * preflight and blocks every auth request on a split-origin deploy.
 */
export const APP_LOCALE_HEADER = "x-app-locale";
