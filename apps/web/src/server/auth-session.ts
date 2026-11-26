import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

import {
  failedRouteSessionResolution,
  type RouteSession,
  type RouteSessionResolution,
  resolvedRouteSession,
} from "@/lib/route-session-access";

type BetterAuthRouteSession = {
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    role?: string | null;
    twoFactorEnabled?: boolean | null;
  };
};

type GetBetterAuthSession = (context: {
  headers: Headers;
}) => Promise<BetterAuthRouteSession | null>;

/**
 * Server-backed session probe for TanStack route guards.
 *
 * Resolves to a {@link RouteSessionResolution} — a lookup failure becomes an
 * `error` resolution the pure access decisions turn into a retryable route
 * error, never a silent logout or fake 404. Cookie-only headers are used so
 * bearer tokens cannot mint a browser route session.
 */
export const getRouteSession = createServerFn({ method: "GET" }).handler(
  async (): Promise<RouteSessionResolution> => routeSessionFromRequestHeaders(getRequestHeaders()),
);

/**
 * The probe behind {@link getRouteSession}, for a request's headers: only the
 * session cookie is passed on. Route guards call `resolveRouteSession()`
 * (`lib/route-session.ts`), which adds the document identity check.
 */
export async function routeSessionFromRequestHeaders(
  headers: Headers,
): Promise<RouteSessionResolution> {
  const [{ auth }, { cookieSessionHeaders }] = await Promise.all([
    import("@ws-model-proxy/auth"),
    import("@ws-model-proxy/auth/cookie-session"),
  ]);
  return resolveRouteSessionFromAuth(cookieSessionHeaders(headers), auth.api.getSession);
}

export async function resolveRouteSessionFromAuth(
  headers: Headers,
  getSession: GetBetterAuthSession,
): Promise<RouteSessionResolution> {
  try {
    const session = await getSession({ headers });
    return resolvedRouteSession(toRouteSession(session));
  } catch {
    return failedRouteSessionResolution();
  }
}

export function toRouteSession(session: BetterAuthRouteSession | null): RouteSession | null {
  if (!session) return null;

  return {
    user: {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      emailVerified: session.user.emailVerified === true,
      role: typeof session.user.role === "string" ? session.user.role : null,
      twoFactorEnabled: session.user.twoFactorEnabled === true,
    },
  };
}
