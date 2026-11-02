import { auth, type Session } from "@ws-model-proxy/auth";
import { cookieSessionHeaders } from "@ws-model-proxy/auth/cookie-session";
import type { Context, Next } from "hono";

// Resolves the Better-Auth session once per request and stashes it on the
// Hono context. Downstream consumers (rate limiter, oRPC createContext, the
// RPC handlers read `c.get("session")` instead of each making
// their own database hit.
//
// Failure mode: a Better-Auth blip becomes "no session" rather than a 500
// for the entire request. The downstream `requireAuth` gates will still
// return 401 if a real session was needed.
export async function sessionMiddleware(c: Context, next: Next) {
  let session: Session | null = null;
  try {
    session = (await auth.api.getSession({
      headers: cookieSessionHeaders(c.req.raw.headers),
    })) as Session | null;
  } catch (err) {
    // Constructor name only — better-auth/Prisma rejections embed SQL,
    // tokens, and credential material in messages and stacks. Never log
    // the raw error here (invariant 10; string-first + raw-Error shape
    // escapes the better-call console shim).
    console.warn(
      "[session-middleware] getSession failed, treating as anonymous:",
      err instanceof Error ? `(Error: ${err.constructor.name})` : typeof err,
    );
    session = null;
  }
  c.set("session", session ?? null);
  await next();
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * An admin's impersonation session is read-only (packages/auth `impersonation-read-only.ts`):
 * after `sessionMiddleware`, a cookie route that changes something (an upload, a Chat Test or
 * pool test request) answers 403 to it. Reads pass.
 */
export async function impersonationReadOnly(c: Context, next: Next) {
  const session = c.get("session") as Session | null | undefined;
  if (session?.session.impersonatedBy && !SAFE_METHODS.has(c.req.method.toUpperCase())) {
    return c.json(
      {
        error: "Changes are not available while impersonating a user. Stop impersonating first.",
        reason: "impersonating",
      },
      403,
    );
  }
  await next();
}
