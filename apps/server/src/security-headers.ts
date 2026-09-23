import type { Env, Hono } from "hono";
import { NONCE, secureHeaders } from "hono/secure-headers";

type SecurityHeadersOptions = {
  // connect-src list for the app CSP (self + optional CORS origin).
  cspConnectSrc: string[];
  // sha256 hash authorizing the inlined anti-FOUC theme bootstrap script.
  themeInitCspHash: string;
};

/** Add explicit ws/wss forms of http(s) origins. `'self'` does not cover a split-origin API. */
export function withWebsocketConnectSources(sources: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    if (seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };
  for (const source of sources) {
    add(source);
    if (source === "'self'" || source.startsWith("ws://") || source.startsWith("wss://")) continue;
    try {
      const url = new URL(source);
      if (url.protocol === "https:") add(`wss://${url.host}`);
      else if (url.protocol === "http:") add(`ws://${url.host}`);
    } catch {
      // Non-URL source keywords stay as given.
    }
  }
  return out;
}

/** Registers the global security headers. */
export function mountSecurityHeaders<E extends Env>(
  app: Hono<E>,
  { cspConnectSrc, themeInitCspHash }: SecurityHeadersOptions,
): void {
  // Secure-headers — sets a battery of security headers (X-Content-Type-Options,
  // X-Frame-Options, Strict-Transport-Security, etc.) on every response.
  app.use(
    "/*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        // NONCE generates a fresh per-request nonce, exposed as
        // c.get("secureHeadersNonce"). The SSR handler forwards it to TanStack
        // Start so its inline hydration scripts carry a matching nonce.
        scriptSrc: [NONCE, "'self'", themeInitCspHash],
        // Intentional product tradeoff: Tailwind/shadcn and SSR theme styles
        // currently rely on inline style attributes. Keep script-src strict;
        // remove this exception after the rendered app no longer needs it.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        // MediaBunny uses same-origin blob workers when compressing an oversized
        // Chat Test video in the browser. Keep workers constrained to this app.
        workerSrc: ["'self'", "blob:"],
        connectSrc: withWebsocketConnectSources(cspConnectSrc),
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        // Injected markup cannot POST credentials to an attacker origin.
        formAction: ["'self'"],
      },
    }),
  );
}
