import { checkAdminAuthority } from "@ws-model-proxy/api";
import { auth, type Session } from "@ws-model-proxy/auth";
import { cookieSessionHeaders } from "@ws-model-proxy/auth/cookie-session";

type AdminSessionGateResult =
  | { ok: true; session: Session }
  | { ok: false; status: 401 | 403; error: string; errorDescription: string };

// This gate protects Better-Auth plugin endpoints whose request surface is
// reached without any oRPC context. It applies the one registered rule,
// `checkAdminAuthority` in `@ws-model-proxy/api` (the same parts `assertAccess`
// checks for the admin levels): verified email, admin role, and forced 2FA.
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

  const authority = await checkAdminAuthority(session);
  if (!authority.ok) {
    return {
      ok: false,
      status: 403,
      error: "access_denied",
      errorDescription:
        authority.reason === "two-factor"
          ? "Two-factor authentication setup is required"
          : "Verified admin access required",
    };
  }

  return { ok: true, session };
}
