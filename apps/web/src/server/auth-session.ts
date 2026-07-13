import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

import type { RouteSession } from "@/lib/route-session-access";

export async function resolveRouteSession(headers: Headers): Promise<RouteSession | null> {
  const [{ auth }, { cookieSessionHeaders }] = await Promise.all([
    import("@ws-model-proxy/auth"),
    import("@ws-model-proxy/auth/cookie-session"),
  ]);
  const session = await auth.api.getSession({
    headers: cookieSessionHeaders(headers),
  });

  if (!session?.user) return null;

  return {
    user: {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      emailVerified: session.user.emailVerified === true,
      role: typeof session.user.role === "string" ? session.user.role : null,
      twoFactorEnabled: session.user.twoFactorEnabled === true,
    },
  } satisfies RouteSession;
}

export const getRouteSession = createServerFn({ method: "GET" }).handler(async () => {
  return resolveRouteSession(new Headers(getRequestHeaders()));
});
