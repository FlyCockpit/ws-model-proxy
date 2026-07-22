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
  async (): Promise<RouteSessionResolution> => {
    const [{ auth }, { cookieSessionHeaders }] = await Promise.all([
      import("@ws-model-proxy/auth"),
      import("@ws-model-proxy/auth/cookie-session"),
    ]);
    return resolveRouteSessionFromAuth(
      cookieSessionHeaders(getRequestHeaders()),
      auth.api.getSession,
    );
  },
);

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

/** @deprecated Prefer resolveRouteSessionFromAuth; kept for tests that assert projection. */
export async function resolveRouteSession(headers: Headers): Promise<RouteSession | null> {
  const [{ auth }, { cookieSessionHeaders }] = await Promise.all([
    import("@ws-model-proxy/auth"),
    import("@ws-model-proxy/auth/cookie-session"),
  ]);
  const resolution = await resolveRouteSessionFromAuth(
    cookieSessionHeaders(headers),
    auth.api.getSession,
  );
  if (resolution.status === "error") {
    throw new Error("Route session unavailable");
  }
  return resolution.session;
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
