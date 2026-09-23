/**
 * Tells a pool grantee that requests may leave the deployment.
 * The pool name and greeting are HTML-escaped. No provider secrets.
 */
import enBundle from "../locales/en-US/pool-external-provider.json";
import esBundle from "../locales/es-MX/pool-external-provider.json";
import { type MailerLocale, resolveMailerLocale } from "../locales/index.js";
import { escapeHtml } from "./html.js";

interface PoolExternalProviderBundle {
  subject: string;
  heading: string;
  body: string;
}

const BUNDLES: Record<MailerLocale, PoolExternalProviderBundle> = {
  "en-US": enBundle as PoolExternalProviderBundle,
  "es-MX": esBundle as PoolExternalProviderBundle,
};

function fallbackString(value: string | undefined, fallback: string): string {
  return value && value.length > 0 ? value : fallback;
}

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => {
    return Object.hasOwn(vars, key) ? vars[key]! : `{{${key}}}`;
  });
}

export interface RenderPoolExternalProviderNoticeArgs {
  /** Recipient display name. HTML-escaped before interpolation. */
  name: string;
  /** Pool display name. HTML-escaped before interpolation. Not a credential. */
  poolName: string;
  /** BCP-47 locale tag. Falls back to en-US if unsupported. */
  locale: string;
}

export interface RenderPoolExternalProviderNoticeResult {
  subject: string;
  html: string;
}

export function renderPoolExternalProviderNotice(
  args: RenderPoolExternalProviderNoticeArgs,
): RenderPoolExternalProviderNoticeResult {
  const locale = resolveMailerLocale(args.locale);
  const bundle = BUNDLES[locale] ?? BUNDLES["en-US"];
  const en = BUNDLES["en-US"];
  const safeName = escapeHtml(args.name);
  const safePool = escapeHtml(args.poolName);
  const vars = { name: safeName, pool: safePool };
  const subject = interpolate(fallbackString(bundle.subject, en.subject), vars);
  const heading = interpolate(fallbackString(bundle.heading, en.heading), vars);
  const body = interpolate(fallbackString(bundle.body, en.body), vars);

  const html = `<!DOCTYPE html>
<html lang="${locale}">
<head><meta charset="utf-8" /></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;padding:40px;max-width:480px">
        <tr><td>
          <h1 style="margin:0 0 16px;font-size:22px;color:#18181b">${heading}</h1>
          <p style="margin:0;font-size:15px;color:#52525b;line-height:1.5">${body}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, html };
}
