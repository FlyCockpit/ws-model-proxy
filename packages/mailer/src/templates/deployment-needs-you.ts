/**
 * Renders the "a deployment needs you" notice: an interactive recipe step waits for its owner
 * (`step`), or an instance whose start is interactive stopped and waits for the owner's restart
 * (`restart`). Same table layout as the other messages; only strings vary by locale. The
 * endpoint slug is HTML-escaped before interpolation.
 */
import enBundle from "../locales/en-US/deployment-needs-you.json";
import esBundle from "../locales/es-MX/deployment-needs-you.json";
import { type MailerLocale, resolveMailerLocale } from "../locales/index.js";
import { escapeHtml, safeHref } from "./html.js";

interface DeploymentNeedsYouBundle {
  subject: string;
  heading: string;
  stepBody: string;
  restartBody: string;
  cta: string;
  footer: string;
}

const BUNDLES: Record<MailerLocale, DeploymentNeedsYouBundle> = {
  "en-US": enBundle as DeploymentNeedsYouBundle,
  "es-MX": esBundle as DeploymentNeedsYouBundle,
};

function pick(bundle: DeploymentNeedsYouBundle, key: keyof DeploymentNeedsYouBundle): string {
  const value = bundle[key];
  return value && value.length > 0 ? value : BUNDLES["en-US"][key];
}

export interface RenderDeploymentNeedsYouArgs {
  /** The instance's endpoint slug. HTML-escaped before interpolation. */
  endpoint: string;
  need: "step" | "restart";
  /** Absolute URL of the dashboard's deployments page. */
  deploymentsUrl: string;
  /** BCP-47 locale tag. Falls back to en-US if unsupported. */
  locale: string;
}

export function renderDeploymentNeedsYou(args: RenderDeploymentNeedsYouArgs): {
  subject: string;
  html: string;
} {
  const locale = resolveMailerLocale(args.locale);
  const bundle = BUNDLES[locale] ?? BUNDLES["en-US"];
  const body = pick(bundle, args.need === "step" ? "stepBody" : "restartBody").replace(
    /\{\{\s*endpoint\s*\}\}/g,
    // A replacer function: `$&`, `$'` and the like in the value are never expanded.
    () => `<strong>${escapeHtml(args.endpoint)}</strong>`,
  );
  const href = safeHref(args.deploymentsUrl);
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
              ${pick(bundle, "cta")}
            </a>
          </p>
          <p style="margin:0;font-size:13px;color:#a1a1aa;line-height:1.5">${pick(bundle, "footer")}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  return { subject: pick(bundle, "subject"), html };
}
