/**
 * Renders the admin-invitation message: a one-time "set your password" link.
 * The email never carries a password — the invitee chooses their own.
 *
 * Layout (table-based inline-CSS HTML) is identical across locales — only the
 * visible strings come from the JSON bundles. The `{{name}}` placeholder in
 * the body is interpolated AFTER HTML-escaping the user-supplied name so a
 * `<script>` in someone's display name can't break out into the markup.
 */
import enBundle from "../locales/en-US/invite-user.json";
import esBundle from "../locales/es-MX/invite-user.json";
import { type MailerLocale, resolveMailerLocale } from "../locales/index.js";
import { escapeHtml, safeHref } from "./html.js";

interface InviteUserBundle {
  subject: string;
  heading: string;
  body: string; // contains {{name}} placeholder
  emailLabel: string;
  cta: string;
  expiryNote: string; // contains {{days}} placeholder
  ignoreFooter: string;
}

const BUNDLES: Record<MailerLocale, InviteUserBundle> = {
  "en-US": enBundle as InviteUserBundle,
  "es-MX": esBundle as InviteUserBundle,
};

function pickBundle(locale: MailerLocale): InviteUserBundle {
  const candidate = BUNDLES[locale];
  return candidate ?? BUNDLES["en-US"];
}

function fallbackString(value: string | undefined, fallback: string): string {
  return value && value.length > 0 ? value : fallback;
}

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    return Object.hasOwn(vars, key) ? vars[key]! : `{{${key}}}`;
  });
}

export interface RenderInviteUserArgs {
  /** Display name for greeting. HTML-escaped before interpolation. */
  name: string;
  /** Email address. HTML-escaped before insertion into the body. */
  email: string;
  /** Absolute one-time URL where the recipient chooses their password. */
  setPasswordUrl: string;
  /** Whole days until the link expires, shown in the expiry note. */
  expiresInDays: number;
  /** BCP-47 locale tag. Falls back to en-US if unsupported. */
  locale: string;
}

export interface RenderInviteUserResult {
  subject: string;
  html: string;
}

export function renderInviteUser(args: RenderInviteUserArgs): RenderInviteUserResult {
  const locale = resolveMailerLocale(args.locale);
  const bundle = pickBundle(locale);
  const en = BUNDLES["en-US"];

  const subject = fallbackString(bundle.subject, en.subject);
  const heading = fallbackString(bundle.heading, en.heading);
  const bodyTemplate = fallbackString(bundle.body, en.body);
  const emailLabel = fallbackString(bundle.emailLabel, en.emailLabel);
  const cta = fallbackString(bundle.cta, en.cta);
  const expiryTemplate = fallbackString(bundle.expiryNote, en.expiryNote);
  const ignoreFooter = fallbackString(bundle.ignoreFooter, en.ignoreFooter);

  const safeName = escapeHtml(args.name);
  const safeEmail = escapeHtml(args.email);
  const href = safeHref(args.setPasswordUrl);
  const greeting = interpolate(bodyTemplate, { name: safeName });
  const expiryNote = interpolate(expiryTemplate, {
    days: escapeHtml(String(Math.max(1, Math.floor(args.expiresInDays)))),
  });

  const html = `<!DOCTYPE html>
<html lang="${locale}">
<head><meta charset="utf-8" /></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;padding:40px;max-width:480px">
        <tr><td>
          <h1 style="margin:0 0 16px;font-size:22px;color:#18181b">${heading}</h1>
          <p style="margin:0 0 16px;font-size:15px;color:#52525b;line-height:1.5">
            ${greeting}
          </p>
          <p style="margin:0 0 8px;font-size:13px;color:#71717a">${emailLabel}</p>
          <p style="margin:0 0 24px;font-size:15px;color:#18181b;font-family:ui-monospace,Menlo,Monaco,monospace">${safeEmail}</p>
          <p style="margin:0 0 16px;text-align:center">
            <a href="${href}" style="display:inline-block;padding:12px 32px;background:#18181b;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:6px">
              ${cta}
            </a>
          </p>
          <p style="margin:0 0 16px;font-size:13px;color:#71717a;line-height:1.5">
            ${expiryNote}
          </p>
          <p style="margin:0;font-size:13px;color:#a1a1aa;line-height:1.5">
            ${ignoreFooter}
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, html };
}
