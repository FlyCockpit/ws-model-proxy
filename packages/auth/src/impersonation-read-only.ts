/**
 * An admin's impersonation session is read-only (security audit 2026-10-31, finding 1).
 *
 * The admin sees what the person sees, to help them, but never acts as them: acting would let
 * the admin mint the person's credentials (agent tokens, MCP grants) or run code on the
 * person's nodes (terminals, node commands, runtimes). The oRPC layer refuses every mutation
 * (packages/api `contractProcedure`); this refuses Better Auth's own writes over HTTP, and every
 * MCP OAuth step (an authorize with a standing consent issues a code without a POST).
 *
 * Allowed while impersonating: stopping it, signing out, and signing in (as oneself).
 * Server-side `auth.api.*` calls carry no request and are not refused here.
 */
import { APIError, getSessionFromCtx } from "better-auth/api";

export const IMPERSONATION_READ_ONLY_MESSAGE =
  "Changes are not available while impersonating a user. Stop impersonating first.";

const ALLOWED_PATHS = new Set(["/admin/stop-impersonating", "/sign-out"]);
const ALLOWED_PREFIXES = ["/sign-in/"];
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Whether an HTTP request to this Better Auth path is refused to an impersonation session. */
export function impersonationRefuses(path: string, method: string): boolean {
  if (path.startsWith("/oauth2/")) return true;
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  if (ALLOWED_PATHS.has(path)) return false;
  return !ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

type AuthMiddlewareContext = Parameters<typeof getSessionFromCtx>[0];

/** Better Auth `hooks.before`: refuses the request when it acts through an impersonation. */
export async function refuseImpersonatedAuthWrite(ctx: AuthMiddlewareContext): Promise<void> {
  const method = ctx.request?.method;
  if (!method || !ctx.path || !impersonationRefuses(ctx.path, method)) return;
  const session = await getSessionFromCtx(ctx);
  if (!session?.session.impersonatedBy) return;
  throw new APIError("FORBIDDEN", {
    message: IMPERSONATION_READ_ONLY_MESSAGE,
    code: "IMPERSONATING",
  });
}
