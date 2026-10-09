/**
 * Renders a share invite (a pool or a runtime definition, to an e-mail not proved yet). Every
 * caller-supplied value (owner name, pool id or runtime name, date) is HTML-escaped before
 * interpolation; the link must be an absolute HTTP(S) URL.
 */
import enBundle from "../locales/en-US/share-invite.json";
import esBundle from "../locales/es-MX/share-invite.json";
import { type MailerLocale, resolveMailerLocale } from "../locales/index.js";
import { escapeHtml, safeHref } from "./html.js";

interface ShareInviteBundle {
  subject: string;
  heading: string;
  body: string;
  runtimeSubject: string;
  runtimeHeading: string;
  runtimeBody: string;
  cta: string;
  expiry: string;
  ignoreFooter: string;
}

const BUNDLES: Record<MailerLocale, ShareInviteBundle> = {
  "en-US": enBundle as ShareInviteBundle,
  "es-MX": esBundle as ShareInviteBundle,
};

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key: string) =>
    Object.hasOwn(vars, key) ? (vars[key] ?? match) : match,
  );
}

export interface RenderShareInviteArgs {
  ownerName: string;
  /** What is shared: a pool (its callable id, `owner/pool`) or a runtime definition (its name). */
  target: { kind: "pool"; callableId: string } | { kind: "runtime"; name: string };
  /** Absolute URL of the invite sign-up page (carries the one-time token). */
  inviteUrl: string;
  expiresAt: Date;
  locale: string;
}

export interface RenderShareInviteResult {
  subject: string;
  html: string;
}

/** A caller-supplied name as plain text: control and format characters blanked, capped. */
function plainText(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 120);
}

export function renderShareInvite(args: RenderShareInviteArgs): RenderShareInviteResult {
  const locale = resolveMailerLocale(args.locale);
  const bundle = BUNDLES[locale] ?? BUNDLES["en-US"];
  const href = safeHref(args.inviteUrl);
  const expiresAt = new Intl.DateTimeFormat(locale, {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(args.expiresAt);
  // The subject is plain text (no HTML), so it takes the raw values with control characters
  // removed; the body takes the escaped ones.
  const plainOwner = plainText(args.ownerName);
  const runtime = args.target.kind === "runtime";
  const subject = interpolate(runtime ? bundle.runtimeSubject : bundle.subject, {
    owner: plainOwner,
  });
  const vars = {
    owner: escapeHtml(args.ownerName),
    ...(args.target.kind === "runtime"
      ? { runtime: `<strong>${escapeHtml(plainText(args.target.name))}</strong>` }
      : { pool: `<code>${escapeHtml(args.target.callableId)}</code>` }),
    expiresAt: escapeHtml(expiresAt),
  };
  const heading = runtime ? bundle.runtimeHeading : bundle.heading;
  const body = runtime ? bundle.runtimeBody : bundle.body;
  const html = `<!DOCTYPE html>
<html lang="${locale}">
<head><meta charset="utf-8" /></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;padding:40px;max-width:480px">
        <tr><td>
          <h1 style="margin:0 0 16px;font-size:22px;color:#18181b">${escapeHtml(heading)}</h1>
          <p style="margin:0 0 24px;font-size:15px;color:#52525b;line-height:1.5">${interpolate(escapeHtml(body), vars)}</p>
          <p style="margin:0 0 24px;text-align:center">
            <a href="${href}" style="display:inline-block;padding:12px 32px;background:#18181b;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:6px">${escapeHtml(bundle.cta)}</a>
          </p>
          <p style="margin:0 0 16px;font-size:13px;color:#71717a;line-height:1.5">${interpolate(escapeHtml(bundle.expiry), vars)}</p>
          <p style="margin:0;font-size:13px;color:#a1a1aa;line-height:1.5">${escapeHtml(bundle.ignoreFooter)}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  return { subject, html };
}
