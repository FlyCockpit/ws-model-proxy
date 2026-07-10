import { auth, type Session } from "@ws-model-proxy/auth";
import { cookieSessionHeaders } from "@ws-model-proxy/auth/cookie-session";
import { isForceTwoFactorRequired } from "@ws-model-proxy/auth/force-two-factor-policy";
import { isAdminRole } from "@ws-model-proxy/auth/roles";

type AdminSessionGateResult =
  | { ok: true; session: Session }
  | { ok: false; status: 401 | 403; error: string; errorDescription: string };

// This gate protects Better-Auth plugin endpoints whose request surface is
// reached without any oRPC context, so it re-implements the same rule as the
// oRPC `requireAdmin` middleware: verified email, admin role, and forced 2FA.
export async function requireVerifiedAdminSession(
  headers: Headers,
): Promise<AdminSessionGateResult> {
  let session: Session | null = null;
  try {
    session = (await auth.api.getSession({
      headers: cookieSessionHeaders(headers),
    })) as Session | null;
  } catch {
    session = null;
  }

  if (!session?.user) {
    return {
      ok: false,
      status: 401,
      error: "unauthorized",
      errorDescription: "Authentication required",
    };
  }

  if (!session.user.emailVerified) {
    return {
      ok: false,
      status: 403,
      error: "access_denied",
      errorDescription: "Verified admin access required",
    };
  }

  if (!isAdminRole(session.user.role)) {
    return {
      ok: false,
      status: 403,
      error: "access_denied",
      errorDescription: "Verified admin access required",
    };
  }

  if ((await isForceTwoFactorRequired()) && !session.user.twoFactorEnabled) {
    return {
      ok: false,
      status: 403,
      error: "access_denied",
      errorDescription: "Two-factor authentication setup is required",
    };
  }

  return { ok: true, session };
}
