import prisma from "@ws-model-proxy/db";
import { fenceOwners, runCapacityOrderedTransaction } from "@ws-model-proxy/db/capacity-lock-order";
import { notifyUserBanned } from "./user-ban-listeners";

/**
 * Password recovery and a password change with sign-out revoke the same standing access.
 * Keep tombstones: issued OAuth JWTs and cached refresh replies are refused by the live
 * grant check on every MCP request. API keys and agent tokens likewise
 * read revokedAt on admission; there is no credential-authority cache to invalidate.
 * The owner fence orders all standing-credential writes; issuers recheck the
 * authorizing session inside that fence, never trusting a request's cached context.
 *
 * Recovery also deletes all sessions before the password transition, under this same
 * fence, then repeats the credential sweep afterward. Pending OAuth codes require
 * their original live session under this fence at exchange, so those die too.
 */
export async function revokeUserCredentials(
  userId: string,
  { revokeSessions = false }: { revokeSessions?: boolean } = {},
): Promise<void> {
  try {
    await runCapacityOrderedTransaction(prisma, async (tx) => {
      await fenceOwners(tx, [userId]);
      // Auth has no secondary session storage and cookieCache is disabled (index.ts).
      // Delete in the credential transaction so a cached request context cannot mint
      // after this fence releases, even if the post-reset sweep fails. An admin's
      // impersonation sessions belong to the target user, but recovery of the acting
      // admin must revoke those too. Repeat that deletion in the post-sweep and on a
      // password change with sign-out, while keeping its newly created current session.
      await tx.session.deleteMany({
        where: revokeSessions
          ? { OR: [{ userId }, { impersonatedBy: userId }] }
          : { impersonatedBy: userId },
      });
      // Better Auth 1.7.18 two-factor stores the user id only on the 2fa-* login
      // challenge and trust-device-* rows. OTP values are `${hashedCode}:${attempts}`
      // and attempt counters are numeric strings, so collect their parent challenge
      // identifiers before deleting anything. Repeat in both sweeps under the fence.
      const challenges = await tx.verification.findMany({
        where: { value: userId, identifier: { startsWith: "2fa-" } },
        select: { identifier: true },
      });
      await tx.verification.deleteMany({
        where: {
          OR: [
            { value: userId, identifier: { startsWith: "2fa-" } },
            { value: userId, identifier: { startsWith: "trust-device-" } },
            {
              identifier: {
                in: challenges.flatMap(({ identifier }) => [
                  `2fa-otp-${identifier}`,
                  `2fa-attempts-${identifier}`,
                ]),
              },
            },
            // OTPs requested with an authenticated session use userId!sessionId.
            { identifier: { startsWith: `2fa-otp-${userId}!` } },
          ],
        },
      });
      const now = new Date();
      const standing = { userId, revokedAt: null };
      const revoked = { revokedAt: now };
      await tx.apiKey.updateMany({ where: standing, data: revoked });
      await tx.agentToken.updateMany({ where: standing, data: revoked });
      await tx.mcpGrant.updateMany({ where: standing, data: revoked });
      // Machine enrollments/credentials are deliberately not revoked here pending the owner's decision.
      await tx.oauthRefreshToken.updateMany({
        where: { userId, revoked: null },
        data: { revoked: now },
      });
      await tx.oauthAccessToken.updateMany({
        where: { userId, revoked: null },
        data: { revoked: now },
      });
      await tx.oauthConsent.deleteMany({ where: { userId } });
    });
    // Reuse the ban announcement to end this user's open streams and relay work.
    // This announces lost access only; it does not ban the user or revoke machine enrollments.
    await notifyUserBanned(userId);
  } catch (error) {
    console.error(
      "[auth] SECURITY: password credential revocation failed; standing credentials may still be live",
      `user=${userId}`,
      error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
    );
    throw error;
  }
}

/** Only a successful password change that requested sign-out may revoke credentials. */
export function passwordChangeRevocationTarget(ctx: {
  path?: string;
  body?: unknown;
  returned?: unknown;
}): string | null {
  if (ctx.path !== "/change-password") return null;
  if (!isRecord(ctx.body) || ctx.body.revokeOtherSessions !== true) return null;
  if (!isRecord(ctx.returned) || !isRecord(ctx.returned.user)) return null;
  const id = ctx.returned.user.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
