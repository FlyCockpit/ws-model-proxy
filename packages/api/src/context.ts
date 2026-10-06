import { auth, type Session } from "@ws-model-proxy/auth";
import { cookieSessionHeaders } from "@ws-model-proxy/auth/cookie-session";
import type { Context as HonoContext } from "hono";
import type { AnonymousAuth, CallerAuth } from "./contracts/auth-context";

export type CreateContextOptions = {
  context: HonoContext;
  services?: ContextServices;
};

/**
 * Server-owned hooks the procedures may call. Injected so the API package never depends on
 * the server; the lanes add the hooks their procedures need (relay pushes, revocations).
 */
export type ContextServices = {
  /**
   * The owning request's abort signal. Long-running procedures (external credential tests)
   * refuse to START network work after the caller is gone.
   */
  signal?: AbortSignal;
  /**
   * A pool's routing rules (or a member's engine-load override) changed and committed. The
   * relay clears the pool's stored verdicts: hot-path rows a management writer must not write.
   */
  onPoolRoutingRulesChanged?: (poolId: string) => Promise<void>;
  /**
   * TODO(server, lane C hook): a runtime got a new version (create, update, fork). Push
   * `runtime.define` to the nodes that need it and answer per node. Absent: the procedures
   * answer `define: []` and nodes pick the version up on their next definition sync.
   */
  pushRuntimeDefinitions?: (input: { userId: string; runtimeId: string }) => Promise<
    Array<{
      nodeId: string;
      status: "applied" | "unchanged" | "rejected" | "pending" | "skipped_trust_relay";
      reason: string | null;
    }>
  >;
  /**
   * TODO(server, lane C hook): a start, restart or stop operation was recorded (instances,
   * ranks and claims written; desired state set). Create and dispatch its steps. Absent: the
   * rows wait for the server's lifecycle sweep.
   */
  dispatchRuntimeOperation?: (input: { userId: string; operationId: string }) => Promise<void>;
};

/**
 * The header oRPC's `SimpleCsrfProtectionLinkPlugin` sends on every `/rpc` call from the web
 * app. A cross-origin page cannot add it without a CORS preflight, which the server grants
 * only to `CORS_ORIGIN`. The server's handler plugin requires it on every procedure in
 * `CSRF_REQUIRED_PROCEDURES` (on every deployment shape) and on every procedure when
 * `CORS_ORIGIN` is set.
 */
export const CSRF_HEADER_NAME = "x-csrf-token";
export const CSRF_HEADER_VALUE = "orpc";

export function requestCarriesCsrfHeader(headers: Headers): boolean {
  return headers.get(CSRF_HEADER_NAME) === CSRF_HEADER_VALUE;
}

export type Context = {
  session: Session | null;
  /** Who is calling, from the credential the transport verified (`contracts/auth-context.ts`). */
  auth: CallerAuth | AnonymousAuth;
  services?: ContextServices;
};

/** The `/rpc` context: a Better Auth cookie session, or anonymous. Never a token. */
export async function createContext({ context, services }: CreateContextOptions): Promise<Context> {
  // The session is resolved once per request by `sessionMiddleware` in apps/server. Test
  // harnesses that bypass the Hono middleware stack see undefined here and look it up.
  const preresolved = context.get("session") as Session | null | undefined;
  const session =
    preresolved !== undefined
      ? preresolved
      : ((await auth.api.getSession({
          headers: cookieSessionHeaders(context.req.raw.headers),
        })) as Session | null);
  return {
    session,
    auth: session
      ? {
          kind: "cookie_session",
          userId: session.user.id,
          sessionId: session.session.id,
          csrfVerified: requestCarriesCsrfHeader(context.req.raw.headers),
        }
      : { kind: "anonymous" },
    services,
  };
}
