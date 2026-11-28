import { checkAdminAuthority } from "@ws-model-proxy/api";
import { auth, type Session } from "@ws-model-proxy/auth";
import { cookieSessionHeaders } from "@ws-model-proxy/auth/cookie-session";
import prisma, { type Prisma } from "@ws-model-proxy/db";
import { userCredentialAccessBlocked } from "@ws-model-proxy/db/user-deletion-access";
import { parseSigned } from "hono/utils/cookie";

type AdminGateFailure = { ok: false; status: 401 | 403; error: string; errorDescription: string };
type AdminSessionGateResult = { ok: true; session: Session } | AdminGateFailure;

const UNAUTHENTICATED: AdminGateFailure = {
  ok: false,
  status: 401,
  error: "unauthorized",
  errorDescription: "Authentication required",
};

// Load the saved actor fresh, including the shared ban/deletion policy fields.
const impersonatorSelect = {
  id: true,
  role: true,
  emailVerified: true,
  banned: true,
  banExpires: true,
  deletionRequestedAt: true,
  twoFactorEnabled: true,
} satisfies Prisma.UserSelect;

// These are cookie-authenticated admin UI surfaces. Strip Authorization before
// any plugin can resolve a bearer as its owner and confer management authority.
async function getCookieSession(headers: Headers): Promise<Session | null> {
  try {
    return (await auth.api.getSession({
      headers: cookieSessionHeaders(headers),
    })) as Session | null;
  } catch {
    return null;
  }
}

// The shared admin rule checks role, verification and forced 2FA. Since this
// actor is loaded directly, also apply the shared ban/deletion access rule.
async function checkVerifiedAdminUser(
  user: Prisma.UserGetPayload<{ select: typeof impersonatorSelect }>,
): Promise<{ ok: true } | AdminGateFailure> {
  if (userCredentialAccessBlocked(user, new Date())) {
    return {
      ok: false,
      status: 403,
      error: "access_denied",
      errorDescription: "Verified admin access required",
    };
  }
  const authority = await checkAdminAuthority({ user });
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
  return { ok: true };
}

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

/**
 * The exact stop-impersonating POST checks the original actor, never the target's
 * role or lifecycle. Better Auth still validates the original request's CSRF,
 * signed cookies and impersonation binding, and restores the existing session.
 */
export async function requireImpersonatorIsVerifiedAdmin(
  headers: Headers,
): Promise<AdminSessionGateResult> {
  const session = await getCookieSession(headers);
  if (!session?.session?.impersonatedBy) return UNAUTHENTICATED;
  try {
    const context = await auth.$context;
    const savedName = context.createAuthCookie("admin_session").name;
    const rawCookies = headers.get("cookie") ?? "";
    const savedEntries = rawCookies
      .split(";")
      .filter((entry) => entry.slice(0, entry.indexOf("=")).trim() === savedName);
    // Better Call and Hono differ on malformed quotes. Only accept the single
    // unquoted cookie Better Auth emits, so both parsers must select the same
    // signed value even when another path/domain cookie has the same name.
    if (savedEntries.length !== 1 || savedEntries[0]?.includes('"')) return UNAUTHENTICATED;
    const cookies = await parseSigned(rawCookies, context.secret);
    const saved = cookies[savedName];
    if (!saved) return UNAUTHENTICATED;
    const [token] = saved.split(":");
    if (!token) return UNAUTHENTICATED;
    // The pinned stop handler does not independently reject an expired or
    // derived saved row. WMP has no session origin field or device-flow plugin;
    // a non-impersonated saved session is its original browser sign-in session.
    const original = await prisma.session.findFirst({
      where: {
        token,
        userId: session.session.impersonatedBy,
        impersonatedBy: null,
        expiresAt: { gt: new Date() },
      },
      select: { user: { select: impersonatorSelect } },
    });
    if (!original) return UNAUTHENTICATED;
    const check = await checkVerifiedAdminUser(original.user);
    if (!check.ok) return check;
    return { ok: true, session };
  } catch {
    return UNAUTHENTICATED;
  }
}
