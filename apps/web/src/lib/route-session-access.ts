import { notFound, redirect } from "@tanstack/react-router";
import { isAdminRole } from "@ws-model-proxy/auth/roles";

import { safeRedirectTo } from "../utils/safe-redirect";

export type RouteSession = {
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    role: string | null;
    twoFactorEnabled: boolean;
  };
};

type ProtectedInput = {
  session: RouteSession | null;
  lang: string;
  href: string;
};

type AnonymousOnlyInput = {
  session: RouteSession | null;
  lang: string;
  redirectTo?: string;
};

type AdminInput = {
  session: RouteSession | null;
};

type DeviceAdminInput = {
  session: RouteSession | null;
  lang: string;
  redirectTo: string;
};

export function requireProtectedRoute({ session, lang, href }: ProtectedInput): RouteSession {
  if (!session) {
    throw redirect({
      to: "/$lang/login",
      params: { lang },
      search: { redirectTo: href },
    });
  }
  return session;
}

export function requireAnonymousOnlyRoute({ session, lang, redirectTo }: AnonymousOnlyInput): void {
  if (session) {
    throw redirect({ href: safeRedirectTo(redirectTo, lang) });
  }
}

export function requireAdminRoute({ session }: AdminInput): RouteSession {
  if (!session?.user.emailVerified || !isAdminRole(session.user.role)) {
    throw notFound();
  }
  return session;
}

export function requireDeviceAdminRoute({
  session,
  lang,
  redirectTo,
}: DeviceAdminInput): RouteSession {
  if (!session) {
    throw redirect({
      to: "/$lang/login",
      params: { lang },
      search: { redirectTo },
    });
  }
  if (!session.user.emailVerified || !isAdminRole(session.user.role)) {
    throw redirect({ to: "/$lang/dashboard", params: { lang } });
  }
  return session;
}
