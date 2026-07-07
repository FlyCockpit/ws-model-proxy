import type { Env, Hono } from "hono";
import { NONCE, secureHeaders } from "hono/secure-headers";

type SecurityHeadersOptions = {
  // connect-src list for the app CSP (self + optional CORS origin).
  cspConnectSrc: string[];
  // sha256 hash authorizing the inlined anti-FOUC theme bootstrap script.
  themeInitCspHash: string;
};

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
        // Intentional product tradeoff: Tailwind/shadcn-driven app UI and AI
        // generated small-business customizations often rely on inline styles.
        // Keep script-src strict; remove this only after auditing app-specific UI.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: cspConnectSrc,
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    }),
  );
}
