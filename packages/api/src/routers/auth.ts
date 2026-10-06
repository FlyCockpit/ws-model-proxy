import prisma from "@ws-model-proxy/db";
import { verifyTransport } from "@ws-model-proxy/mailer";
import { contractProcedure, publicContractProcedure } from "../contract-procedure";
import { authContract as c } from "../contracts/account";
import { callableIdOf } from "../lib/access-views";
import { canUserChangePassword } from "../lib/password-capabilities";
import { pendingInviteWhere, shareInviteDigest } from "../lib/share-invites";

export const authRouter = {
  /**
   * The invite sign-up page: who invited this e-mail to which pool. Answers `valid: false`
   * (and nothing else) for an unknown, used, withdrawn or expired link, so it reveals nothing
   * without a live token. TODO(server): rate-limit like sign-in (apps/server `/rpc` limiter).
   */
  inviteInfo: publicContractProcedure(c.inviteInfo).handler(async ({ input }) => {
    const invite = await prisma.shareInvite.findFirst({
      where: { tokenDigest: shareInviteDigest(input.token), ...pendingInviteWhere(new Date()) },
      select: {
        email: true,
        Owner: { select: { name: true } },
        Pool: { select: { slug: true, User: { select: { slug: true } } } },
      },
    });
    if (!invite) return { valid: false, email: null, ownerName: null, callableId: null };
    return {
      valid: true,
      email: invite.email,
      ownerName: invite.Owner.name,
      callableId: callableIdOf(invite.Pool.User.slug, invite.Pool.slug),
    };
  }),
  /**
   * Delivery-aware preflight for the email-OTP second factor. The login challenge calls this
   * BEFORE `authClient.twoFactor.sendOtp()` because Better Auth's send-otp endpoint swallows
   * `sendOTP` failures and always returns success.
   *
   * Public: the caller is mid-2FA (password verified, no full session yet). It is rate-limited
   * by the shared `/rpc` limiter and only handshakes the app's own SMTP host.
   */
  verifyEmailTransport: publicContractProcedure(c.verifyEmailTransport).handler(async () => {
    return { ok: await verifyTransport() };
  }),
  /** Persist the signed-in person's UI locale so it follows them across devices. */
  updateLocale: contractProcedure(c.updateLocale).handler(async ({ input, context }) => {
    await prisma.user.update({
      where: { id: context.session.user.id },
      data: { locale: input.locale },
    });
    return { success: true as const };
  }),
  passwordCapabilities: contractProcedure(c.passwordCapabilities).handler(async ({ context }) => {
    return {
      canChangePassword: await canUserChangePassword({
        userId: context.session.user.id,
        forceSso: false,
      }),
    };
  }),
};
