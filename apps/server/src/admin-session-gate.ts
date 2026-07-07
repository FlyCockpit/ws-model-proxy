import { auth, type Session } from "@ws-model-proxy/auth";
import { isAdminRole } from "@ws-model-proxy/auth/roles";
import prisma from "@ws-model-proxy/db";

type AdminSessionGateResult =
  | { ok: true; session: Session }
  | { ok: false; status: 401 | 403; error: string; errorDescription: string };

async function isForce2faEnabled(): Promise<boolean> {
  const setting = await prisma.appSetting.findUnique({
    where: { key: "force2fa" },
    select: { value: true },
  });
  return setting?.value === "true";
}

// This gate protects Better-Auth plugin endpoints whose request surface is
// reached without any oRPC context, so it re-implements the same rule as the
// oRPC `requireAdmin` middleware: verified email, admin role, and forced 2FA.
export async function requireVerifiedAdminSession(
  headers: Headers,
): Promise<AdminSessionGateResult> {
  let session: Session | null = null;
  try {
    session = (await auth.api.getSession({ headers })) as Session | null;
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

  if ((await isForce2faEnabled()) && !session.user.twoFactorEnabled) {
    return {
      ok: false,
      status: 403,
      error: "access_denied",
      errorDescription: "Two-factor authentication setup is required",
    };
  }

  return { ok: true, session };
}
