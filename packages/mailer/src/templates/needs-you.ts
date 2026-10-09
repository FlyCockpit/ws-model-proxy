/**
 * Renders the "Needs you" notice (spec §7.4): an interactive step waits for its owner (`step`),
 * a runtime whose start is interactive stopped and waits for a restart (`restart`), an instance
 * waits for Mark as stopped (`mark_stopped`), or an agent queued a command for the person
 * (`queued_command`). Same table layout as the other messages; only strings vary by locale.
 * `name` (the runtime's name, or the node's slug for a queued command) is HTML-escaped in the
 * body and flattened to one line in the subject.
 */
import enBundle from "../locales/en-US/needs-you.json";
import esBundle from "../locales/es-MX/needs-you.json";
import { type MailerLocale, resolveMailerLocale } from "../locales/index.js";
import { escapeHtml, safeHref } from "./html.js";

type NeedsYouBundle = typeof enBundle;

const BUNDLES: Record<MailerLocale, NeedsYouBundle> = {
  "en-US": enBundle,
  "es-MX": esBundle,
};

export const NEEDS_YOU_KINDS = ["step", "restart", "mark_stopped", "queued_command"] as const;
export type NeedsYouKind = (typeof NEEDS_YOU_KINDS)[number];

const KEY_PREFIX: Record<NeedsYouKind, "step" | "restart" | "markStopped" | "queuedCommand"> = {
  step: "step",
  restart: "restart",
  mark_stopped: "markStopped",
  queued_command: "queuedCommand",
};

function pick(bundle: NeedsYouBundle, key: keyof NeedsYouBundle): string {
  const value = bundle[key];
  return value && value.length > 0 ? value : BUNDLES["en-US"][key];
}

const NAME_TOKEN = /\{\{\s*name\s*\}\}/g;

export interface RenderNeedsYouArgs {
  kind: NeedsYouKind;
  /** The runtime's name, or the node's slug for a queued command. */
  name: string;
  /** Absolute URL of the page where the person resolves it (Terminals or the runtime page). */
  actionUrl: string;
  /** BCP-47 locale tag. Falls back to en-US if unsupported. */
  locale: string;
}

export function renderNeedsYou(args: RenderNeedsYouArgs): { subject: string; html: string } {
  const locale = resolveMailerLocale(args.locale);
  const bundle = BUNDLES[locale] ?? BUNDLES["en-US"];
  const prefix = KEY_PREFIX[args.kind];
  // A replacer function: `$&`, `$'` and the like in the name are never expanded.
  const body = pick(bundle, `${prefix}Body`).replace(
    NAME_TOKEN,
    () => `<strong>${escapeHtml(args.name)}</strong>`,
  );
  const plainName = args.name
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .trim()
    .slice(0, 80);
  const subject = pick(bundle, `${prefix}Subject`).replace(NAME_TOKEN, () => plainName);
  const href = safeHref(args.actionUrl);
  const html = `<!DOCTYPE html>
<html lang="${locale}">
<head><meta charset="utf-8" /></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;padding:40px;max-width:480px">
        <tr><td>
          <h1 style="margin:0 0 16px;font-size:22px;color:#18181b">${pick(bundle, "heading")}</h1>
          <p style="margin:0 0 24px;font-size:15px;color:#52525b;line-height:1.5">${body}</p>
          <p style="margin:0 0 24px;text-align:center">
            <a href="${href}" style="display:inline-block;padding:12px 32px;background:#18181b;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:6px">
              ${pick(bundle, `${prefix}Cta`)}
            </a>
          </p>
          <p style="margin:0;font-size:13px;color:#a1a1aa;line-height:1.5">${pick(bundle, "footer")}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  return { subject, html };
}
