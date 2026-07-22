import { DEFAULT_LOCALE, isSupportedLocale } from "@ws-model-proxy/config/locales";

/**
 * Where the emailed verification link lands the user after Better-Auth has
 * validated the token server-side.
 *
 * Better-Auth builds the emailed URL as
 * `${baseURL}/verify-email?token=<jwt>&callbackURL=<encoded>` and, in its
 * `/verify-email` handler, 302s to that `callbackURL` — bare on success, or
 * with `?error=<CODE>` appended when the token doesn't check out. Without a
 * `callbackURL` the default is `/`, which dumps a freshly-verified user on
 * the home page with no confirmation.
 *
 * We rewrite it here so every path that mails a verification link lands on the
 * same `/$lang/verify-email` page. The destination carries `?ok=1` so a bare
 * visit cannot read as success. A caller-supplied `callbackURL` is preserved
 * only when it is a safe same-origin path or allowed origin (open-redirect
 * defense).
 */
export function withVerificationCallback(url: string, locale: unknown, appOrigin?: string): string {
  const tag = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE;
  try {
    const parsed = new URL(url);
    const fallback = buildCallback(tag, appOrigin);
    const existing = parsed.searchParams.get("callbackURL");
    if (existing && existing !== "/" && isSafeCallback(existing, appOrigin, parsed.origin)) {
      parsed.searchParams.set("callbackURL", absolutize(existing, appOrigin));
      return parsed.toString();
    }
    parsed.searchParams.set("callbackURL", fallback);
    return parsed.toString();
  } catch {
    return url;
  }
}

function buildCallback(tag: string, appOrigin?: string): string {
  return absolutize(`/${tag}/verify-email?ok=1`, appOrigin);
}

function absolutize(path: string, appOrigin?: string): string {
  if (!appOrigin || !path.startsWith("/")) return path;
  try {
    return new URL(path, appOrigin).toString();
  } catch {
    return path;
  }
}

const SAFE_RELATIVE_PATH = /^\/(?!\/|\\|%2f|%5c)[\w\-.+/@]*(?:\?[\w\-.+/=&%@]*)?$/i;

function isSafeCallback(value: string, appOrigin: string | undefined, apiOrigin: string): boolean {
  if (SAFE_RELATIVE_PATH.test(value)) return true;
  try {
    const target = new URL(value);
    return (
      target.origin === apiOrigin || (!!appOrigin && target.origin === new URL(appOrigin).origin)
    );
  } catch {
    return false;
  }
}
