import { DEFAULT_LOCALE, isSupportedLocale } from "@ws-model-proxy/config/locales";
import prisma from "@ws-model-proxy/db";
import { renderResetPassword, sendEmail } from "@ws-model-proxy/mailer";

/** A reset link is good for one hour (and one use). The mail copy says so. */
export const RESET_PASSWORD_TOKEN_EXPIRES_IN_SECONDS = 60 * 60;

const RESET_PAGE_PATH = /^\/([^/?#]+)\/reset-password\/?$/;

/**
 * Where the emailed reset link lands after Better Auth checked the token.
 *
 * Better Auth mails `${baseURL}/reset-password/<token>?callbackURL=<redirectTo>`
 * and its GET handler 302s to `callbackURL` with `?token=<token>` (valid) or
 * `?error=INVALID_TOKEN`. The callback therefore receives a live credential,
 * so it is ALWAYS rewritten to the app's own `/$lang/reset-password` page:
 * a caller's `redirectTo` only contributes its locale, and only when it names
 * that page on the API origin or the app origin. Anything else (another path,
 * another origin, garbage) falls back to the recipient's stored locale.
 *
 * `appOrigin` is CORS_ORIGIN on split-origin deploys: the absolute callback
 * then lands on the web app rather than the API host. Without it the callback
 * stays relative, which Better Auth resolves against its own origin.
 */
export function withResetPasswordCallback(
  url: string,
  recipientLocale: unknown,
  appOrigin?: string,
): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const requested = requestedResetLocale(
    parsed.searchParams.get("callbackURL"),
    parsed.origin,
    appOrigin,
  );
  const tag = requested ?? (isSupportedLocale(recipientLocale) ? recipientLocale : DEFAULT_LOCALE);
  parsed.searchParams.set("callbackURL", absolutize(`/${tag}/reset-password`, appOrigin));
  return parsed.toString();
}

/** The locale of a callback that names the reset page on a trusted origin, else null. */
function requestedResetLocale(
  callback: string | null,
  apiOrigin: string,
  appOrigin: string | undefined,
): string | null {
  if (!callback) return null;
  let target: URL;
  try {
    // A leading "//" or "\" would make a protocol-relative URL; a plain path
    // resolves against the API origin, which is trusted.
    if (/^[/\\]{2}/.test(callback)) return null;
    target = new URL(callback, apiOrigin);
  } catch {
    return null;
  }
  const trusted = new Set([apiOrigin]);
  if (appOrigin) {
    try {
      trusted.add(new URL(appOrigin).origin);
    } catch {
      // An unparseable app origin trusts nothing extra.
    }
  }
  if (!trusted.has(target.origin)) return null;
  const tag = RESET_PAGE_PATH.exec(target.pathname)?.[1];
  return tag && isSupportedLocale(tag) ? tag : null;
}

function absolutize(path: string, appOrigin?: string): string {
  if (!appOrigin) return path;
  try {
    return new URL(path, appOrigin).toString();
  } catch {
    return path;
  }
}

/**
 * Mails the reset link. Started without being awaited by `sendResetPassword`,
 * so neither the locale lookup nor SMTP latency or failure shows in the
 * response. It never rejects: a failure is logged by error class only (never
 * the address or the link).
 */
export async function deliverResetPasswordEmail(
  user: { id: string; email: string },
  url: string,
  appOrigin: string | undefined,
): Promise<void> {
  try {
    const row = await prisma.user.findUnique({
      where: { id: user.id },
      select: { locale: true },
    });
    const { subject, html } = renderResetPassword({
      url: withResetPasswordCallback(url, row?.locale, appOrigin),
      locale: row?.locale ?? DEFAULT_LOCALE,
    });
    await sendEmail({ to: user.email, subject, html });
  } catch (error) {
    console.error(
      "[auth] password reset mail failed:",
      error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
    );
  }
}

type SendResetPassword = (data: {
  user: { id: string; email: string };
  url: string;
}) => Promise<void>;

/**
 * The `emailAndPassword` reset options. Reset by email exists only with SMTP:
 * without `sendResetPassword` Better Auth refuses `/request-password-reset`
 * (RESET_PASSWORD_DISABLED) and the web app hides the "Forgot password?" link.
 * A successful reset signs the account out everywhere.
 */
export function passwordResetOptions(
  emailConfigured: boolean,
  appOrigin: string | undefined,
): {
  revokeSessionsOnPasswordReset: true;
  resetPasswordTokenExpiresIn: number;
  sendResetPassword?: SendResetPassword;
} {
  const base = {
    revokeSessionsOnPasswordReset: true as const,
    resetPasswordTokenExpiresIn: RESET_PASSWORD_TOKEN_EXPIRES_IN_SECONDS,
  };
  if (!emailConfigured) return base;
  return {
    ...base,
    // Not awaited (Better Auth's advice): SMTP latency stays out of the response. The
    // delivery never rejects (it logs by error class); the extra catch guards a sync throw.
    sendResetPassword: async ({ user, url }) => {
      void Promise.resolve()
        .then(() => deliverResetPasswordEmail(user, url, appOrigin))
        .catch((error: unknown) => {
          console.error(
            "[auth] password reset mail failed:",
            error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
          );
        });
    },
  };
}
