import { auth, type Session } from "@ws-model-proxy/auth";
import { cookieSessionHeaders } from "@ws-model-proxy/auth/cookie-session";
import type { Context as HonoContext } from "hono";

export type CreateContextOptions = {
  context: HonoContext;
  services?: ContextServices;
};

export type ContextServices = {
  /** Server-owned accounting repair. Kept injectable so the API package does not depend on the server. */
  repairExpiredProviderBudgets?: (scope: {
    userId: string;
    providerAccountId: string;
  }) => Promise<number>;
};

export async function createContext({ context, services }: CreateContextOptions) {
  // The session is resolved once per request by `sessionMiddleware` in
  // apps/server. Test harnesses that bypass the Hono middleware stack will
  // see undefined here — fall back to a direct lookup so they still work.
  const preresolved = context.get("session") as Session | null | undefined;
  const session =
    preresolved !== undefined
      ? preresolved
      : ((await auth.api.getSession({
          headers: cookieSessionHeaders(context.req.raw.headers),
        })) as Session | null);
  return {
    session,
    services,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
