import { isForceTwoFactorRequired } from "@ws-model-proxy/auth/force-two-factor-policy";
import prisma from "@ws-model-proxy/db";
import { userCredentialAccessBlocked } from "@ws-model-proxy/db/user-deletion-access";

/**
 * Whether a dashboard session may still run a Chat Test live session: the
 * Better Auth session row exists, belongs to the user and has not expired
 * (sign-out and session revocation delete it), the user has no active ban or
 * pending deletion, and, while the force-2FA policy is on, the user is
 * enrolled (the dashboard's `protectedProcedure` rule). The same rules as the
 * browser terminal socket's admission and recheck. A read that throws
 * propagates: the caller refuses the upgrade or skips one recheck sweep.
 */
export type DashboardSessionVerdict = "ok" | "ended" | "blocked" | "two_factor_required";

export async function checkDashboardSession({
  sessionId,
  userId,
  now = new Date(),
  twoFactorRequired = isForceTwoFactorRequired,
}: {
  sessionId: string;
  userId: string;
  now?: Date;
  twoFactorRequired?: () => Promise<boolean>;
}): Promise<DashboardSessionVerdict> {
  const row = await prisma.session.findUnique({
    where: { id: sessionId },
    select: {
      userId: true,
      expiresAt: true,
      user: {
        select: {
          twoFactorEnabled: true,
          banned: true,
          banExpires: true,
          deletionRequestedAt: true,
        },
      },
    },
  });
  if (!row || row.userId !== userId || row.expiresAt.getTime() <= now.getTime()) return "ended";
  // `user` is a required relation; a vanished row still refuses.
  if (!row.user || userCredentialAccessBlocked(row.user, now)) return "blocked";
  if ((await twoFactorRequired()) && !row.user.twoFactorEnabled) return "two_factor_required";
  return "ok";
}
