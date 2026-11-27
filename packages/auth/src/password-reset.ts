import { DEFAULT_LOCALE, isSupportedLocale } from "@ws-model-proxy/config/locales";
import prisma from "@ws-model-proxy/db";
import { renderResetPassword, sendEmail } from "@ws-model-proxy/mailer";
import {
  ADMIN_INVITED_PREFIX,
  lockCredentialSetup,
  RESET_PASSWORD_IDENTIFIER_PREFIX,
} from "./credential-setup-lock";
import { recordResetLinkMailed } from "./password-reset-links";

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
 *
 * First it records that `token` goes to the mailbox (password-reset-links.ts
 * `recordResetLinkMailed`): a forgot-password link is never shown to anyone,
 * so recording before the send leaves no moment where the delivered link is
 * not yet known as mailed. Spending it then verifies (and proves) the address
 * and works for an active account. Without the record the link would be
 * refused for any account but a pending invite, so no mail is sent then; the
 * person asks again.
 */
export async function deliverResetPasswordEmail(
  user: { id: string; email: string },
  url: string,
  token: string,
  appOrigin: string | undefined,
): Promise<void> {
  try {
    if (!(await recordResetLinkMailed({ token, userId: user.id, email: user.email }))) {
      console.error("[auth] password reset mail skipped: the link is already gone");
      return;
    }
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
  token: string;
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
  onPasswordReset: (data: { user: { id: string; email: string } }) => Promise<void>;
} {
  const base = {
    revokeSessionsOnPasswordReset: true as const,
    // Under the per-user credential-setup lock, every other reset link of the
    // user is deleted, so an invite resend racing this reset never leaves a
    // working link behind.
    //
    // With SMTP, whether the reset also verifies the address is decided by the
    // `/reset-password` after-hook (index.ts), which knows the spent token: only
    // a link that was mailed verifies and proves it (password-reset-links.ts);
    // this callback is told only the user. Without SMTP nothing is mailed,
    // verified by mail or proved: every public sign-up is created verified
    // (user-create-policy.ts), and spending an admin invite's link (the only way
    // in, credential-setup-lock.ts ADMIN_INVITED_PREFIX) activates it the same
    // way, so it is marked verified here. Reset links carry no address, so
    // Better Auth's update routes refuse an email change (index.ts
    // `databaseHooks.user.update`).
    onPasswordReset: async ({ user }: { user: { id: string; email: string } }) => {
      await prisma.$transaction(async (tx) => {
        await lockCredentialSetup(tx, user.id);
        const invited =
          !emailConfigured &&
          (await tx.verification.findFirst({
            where: { identifier: `${ADMIN_INVITED_PREFIX}${user.id}` },
            select: { id: true },
          }));
        if (invited) {
          await tx.user.updateMany({
            where: { id: user.id, email: user.email },
            data: { emailVerified: true },
          });
        }
        await tx.verification.deleteMany({
          where: { value: user.id, identifier: { startsWith: RESET_PASSWORD_IDENTIFIER_PREFIX } },
        });
      });
    },
    resetPasswordTokenExpiresIn: RESET_PASSWORD_TOKEN_EXPIRES_IN_SECONDS,
  };
  if (!emailConfigured) return base;
  return {
    ...base,
    // Not awaited (Better Auth's advice): SMTP latency stays out of the response. The
    // delivery never rejects (it logs by error class); the extra catch guards a sync throw.
    sendResetPassword: async ({ user, url, token }) => {
      void Promise.resolve()
        .then(() => deliverResetPasswordEmail(user, url, token, appOrigin))
        .catch((error: unknown) => {
          console.error(
            "[auth] password reset mail failed:",
            error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
          );
        });
    },
  };
}
